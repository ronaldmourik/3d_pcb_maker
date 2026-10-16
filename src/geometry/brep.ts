// Builds the printable B-rep parts (board / halves / dowels / stamps) with OpenCascade.
import { cast, getOC, makeCompound, makeCylinder, type AnyShape, type Shape3D } from 'replicad';
import type { BoardInput, Contour, Pt } from '../gerber/types';
import { buildOutline, type OutlineShape } from '../gerber/outline';
import { addPt, contourPoints, drillsBounds, emptyBounds, isEmpty, primitivesBounds, type Bounds } from '../gerber/geom2d';
import { resolveSides, type Settings } from '../state/settings';
import { circlesFace, contourFace, drillsFace, layerFace, type FaceStats } from './faces';
import { common, cutAll, fuseAll, isNullOrEmpty, isValid, prism, unify } from './occ';
import { placeDowels } from './dowels';
import { chamferTools, edgeChamferTools, type ChamferStats } from './chamfer';
import { GeometryCache, hashValue } from './cache';
import { narrowGaps, narrowTraces, smallHoles, vanishedRegions } from './printability';
import { faceLoops } from './paths';
import { mapPattern, type CutPattern, type PathSeg } from '../export/paths2d';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TopoShape = any;
type Warn = (w: string) => void;
type Report = (i: Issue) => void;

/** A problem at a specific spot of the board (board coordinates of that copper side). */
export interface Issue {
  message: string;
  side: 'top' | 'bottom';
  at: Pt;
}

export type PartId = 'board' | 'topHalf' | 'bottomHalf' | 'dowels' | 'stampTop' | 'stampBottom';

export interface Body {
  name: string;
  shape: Shape3D;
  color: string;
}

export interface Part {
  id: PartId;
  label: string;
  bodies: Body[];
}

export interface BuildResult {
  name: string;
  parts: Part[];
  warnings: string[];
  doubleSided: boolean;
  /** Outline bounds in board coordinates. */
  bounds: Bounds;
  dowelPositions: Pt[];
  dowelLength: number;
  dowelDiameter: number;
  /** Stages reused from the geometry cache in this build. */
  cacheHits: number;
  issues: Issue[];
  /** Copper cut patterns per side, oriented as on the printed part (copper face up). */
  cutPatterns: Partial<Record<'top' | 'bottom', CutPattern>>;
}

export const COLORS = {
  board: '#ece8dc',
  copper: '#c87533',
  stamp: '#5b8dd9',
  dowel: '#8a8a8a',
  issue: '#e53e3e',
};

const PART_LABELS: Record<PartId, string> = {
  board: 'Board',
  topHalf: 'Top half',
  bottomHalf: 'Bottom half',
  dowels: 'Dowels',
  stampTop: 'Stamp (top)',
  stampBottom: 'Stamp (bottom)',
};

const as3D = (s: AnyShape) => s as Shape3D;
/** Copper areas with more boundary edges than this (large pours) are not bevelled: too slow. */
const MAX_CHAMFER_EDGES = 400;
const key = (...parts: unknown[]) => parts.map((p) => (typeof p === 'number' ? String(+p.toFixed(5)) : String(p))).join('|');

/** Dispose all bodies of a build (they are clones, never shared with the cache). */
export function disposeBuild(r: BuildResult) {
  for (const p of r.parts) for (const b of p.bodies) b.shape.delete();
}

export function buildModel(
  input: BoardInput,
  s: Settings,
  log: (msg: string) => void = () => {},
  cache: GeometryCache = new GeometryCache(),
): BuildResult {
  cache.scope(hashValue(input));
  const warnings: string[] = [];
  const issues: Issue[] = [];
  /** Run a cached stage; warnings/issues it raised are stored with it and replayed on a cache hit. */
  const staged = <T>(k: string, make: (warn: Warn, report: Report) => T): T => {
    const r = cache.get(k, () => {
      const w: string[] = [];
      const iss: Issue[] = [];
      return { value: make((m) => w.push(m), (i) => iss.push(i)), warnings: w, issues: iss };
    });
    warnings.push(...r.warnings);
    issues.push(...r.issues);
    return r.value;
  };

  const hasTop = !!input.top?.some((p) => p.dark);
  const hasBottom = !!input.bottom?.some((p) => p.dark);
  const sides = resolveSides(s.sides, hasTop, hasBottom);
  if (!sides) throw new Error('No copper layer found. Upload a top and/or bottom copper Gerber.');
  if (sides !== s.sides) warnings.push(`Only the ${sides} copper layer is available; generating a single-sided board.`);
  const doubleSided = sides === 'both';

  // ---- outline ----
  const outlineKey = key('outline', s.outlineSource, s.margin);
  const { shapes, bounds, outlineFace } = staged(outlineKey, (warn) => {
    log('Building outline');
    let shapes: OutlineShape[] = [];
    if (s.outlineSource === 'edge-cuts') {
      if (input.outline?.length) {
        const r = buildOutline(input.outline);
        shapes = r.shapes;
        if (r.openSegments) warn(`${r.openSegments} outline segment(s) did not form a closed loop and were ignored.`);
        if (!shapes.length) warn('Outline layer has no closed contour; using the bounding box instead.');
      } else {
        warn('No outline (Edge.Cuts) layer; using the copper bounding box.');
      }
    }
    if (!shapes.length) {
      const b = emptyBounds();
      if (hasTop) primitivesBounds(input.top!, b);
      if (hasBottom) primitivesBounds(input.bottom!, b);
      drillsBounds(input.drills, b);
      for (const silk of [input.silkTop, input.silkBottom]) if (silk) primitivesBounds(silk, b);
      if (isEmpty(b)) throw new Error('Nothing to build: the layers are empty.');
      const m = s.margin;
      shapes = [{ outer: rectContour(b.minX - m, b.minY - m, b.maxX + m, b.maxY + m), holes: [] }];
    }
    const bounds = emptyBounds();
    for (const sh of shapes) for (const p of contourPoints(sh.outer)) addPt(bounds, p);
    const outlineFace: TopoShape = unify(fuseAll(shapes.map((sh) => contourFace(sh.outer, sh.holes))));
    return { shapes, bounds, outlineFace };
  });
  const cx = (bounds.minX + bounds.maxX) / 2;

  /** Merged copper of one side grown by `offset`, clipped to the outline (shared, do not consume). */
  const copperFace = (side: 'top' | 'bottom', offset: number): TopoShape | null =>
    staged(key(outlineKey, 'copper', side, offset), (warn, report) => {
      const label = `Merging ${side} copper${offset ? ` (offset ${offset.toFixed(2)} mm)` : ''}`;
      log(label);
      const prims = (side === 'top' ? input.top : input.bottom) ?? [];
      const st: FaceStats = { failed: 0 };
      let f = layerFace(prims, offset, st, (i, n) => log(`${label} ${i}/${n}`));
      if (st.failed) warn(`${st.failed} copper primitive(s) could not be converted and were skipped.`);
      for (const at of (st.failedAt ?? []).slice(0, 20)) report({ message: 'Copper shape could not be converted', side, at });
      if (f) {
        f = unify(common(f, outlineFace));
        if (isNullOrEmpty(f)) f = null;
      }
      return f;
    });

  const holesKey = key('holes', s.holes, s.holeOffset, s.minHoleDiameter);
  const holesSolid: AnyShape | null = cache.get(holesKey, () => {
    log('Building holes');
    const holesFace = s.holes ? drillsFace(input.drills, s.holeOffset, s.minHoleDiameter) : null;
    return holesFace ? prism(holesFace, -50, 200) : null;
  });
  const mirrorX = <T extends AnyShape>(shape: T): T => shape.mirror('YZ', [cx, 0, 0]) as T;

  /** Chamfer the top rim of the recessed channels (before drilling, so holes stay sharp). */
  const chamferChannels = (board: Shape3D, side: 'top' | 'bottom', top: number, depth: number, warn: Warn, report: Report): Shape3D => {
    const size = Math.min(s.channelChamfer, depth - 0.05);
    if (size < s.channelChamfer) warn(`Channel chamfer limited to ${size.toFixed(2)} mm by the channel depth.`);
    if (size <= 0.01) return board;
    log(`Chamfering ${side} channels`);
    const prims = (side === 'top' ? input.top : input.bottom) ?? [];
    const cs: ChamferStats = { lofted: 0, stepped: 0, failed: 0 };
    try {
      const tools = chamferTools(prims, s.copperOffset, top, size, cs, (i, n) => log(`Chamfering ${side} channels ${i}/${n}`));
      for (const at of (cs.failedAt ?? []).slice(0, 20)) report({ message: 'Copper shape could not be chamfered', side, at });
      for (const at of cs.skippedAt ?? []) report({ message: 'Copper pour left without channel chamfer', side, at });
      const chamfered = as3D(cast(cutAll(board.wrapped, tools)));
      if (cs.stepped) warn(`${cs.stepped} irregular copper shape(s) got a stepped chamfer approximation.`);
      if (cs.failed) warn(`${cs.failed} copper shape(s) could not be chamfered.`);
      if (isValid(chamfered.wrapped)) return chamfered;
    } catch {
      /* fall through */
    }
    warn('Channel chamfer failed; channels left sharp.');
    return board;
  };

  /** Chamfer the top edges of raised copper (exact, from the merged outline). */
  // Each copper island is chamfered on its own: many small booleans are far faster than one with
  // hundreds of overlapping tools, and islands never interact.
  const chamferRaised = (copper: Shape3D, cf: TopoShape, side: 'top' | 'bottom', top: number, warn: Warn, report: Report): Shape3D => {
    const size = Math.min(s.channelChamfer, s.traceHeight - 0.05);
    if (size < s.channelChamfer) warn(`Edge chamfer limited to ${size.toFixed(2)} mm by the trace height.`);
    if (size <= 0.01) return copper;
    try {
      const islands = faceList(cf);
      const solids = islands.map((face, i) => {
        log(`Chamfering ${side} traces ${i + 1}/${islands.length}`);
        const island = prism(face, top - s.traceHeight, s.traceHeight).wrapped;
        const loops = faceLoops(face);
        const centre = (): Pt => {
          const [min, max] = cast(face).boundingBox.bounds;
          return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
        };
        const edges = loops.reduce((n, l) => n + l.length, 0);
        if (edges > MAX_CHAMFER_EDGES) {
          report({ message: `Large copper area (${edges} edges) left without edge chamfer`, side, at: centre() });
          return island;
        }
        try {
          const r = cutChamferTools(island, loops, top, size);
          if (isValid(r)) return r;
        } catch {
          /* report below */
        }
        report({ message: 'Copper area left without edge chamfer', side, at: centre() });
        return island;
      });
      const chamfered = as3D(cast(solids.length === 1 ? solids[0] : makeCompound(solids.map((x) => cast(x))).wrapped));
      if (isValid(chamfered.wrapped)) return chamfered;
    } catch {
      /* fall through */
    }
    warn('Trace edge chamfer failed; edges left sharp.');
    return copper;
  };

  /** Silkscreen of one side: strokes widened to a printable width, kept clear of copper and the outline. */
  const silkFace = (side: 'top' | 'bottom'): TopoShape | null => {
    const prims = (side === 'top' ? input.silkTop : input.silkBottom) ?? [];
    if (s.silkMode === 'off' || !prims.some((p) => p.dark)) return null;
    return staged(key(outlineKey, 'silk', side, s.silkMinWidth, s.silkClearance, s.copperOffset), (warn) => {
      log(`Merging ${side} silkscreen`);
      const wide = prims.map((p) => (p.kind === 'stroke' && p.width < s.silkMinWidth ? { ...p, width: s.silkMinWidth } : p));
      const st: FaceStats = { failed: 0 };
      let f = layerFace(wide, 0, st);
      if (st.failed) warn(`${st.failed} silkscreen shape(s) could not be converted and were skipped.`);
      if (!f) return null;
      const keepOut = copperFace(side, s.copperOffset + s.silkClearance);
      if (keepOut) f = cutAll(f, [keepOut]);
      f = unify(common(f, outlineFace));
      return isNullOrEmpty(f) ? null : f;
    });
  };

  // ---- board / halves ----
  const buildSlab = (thickness: number, side: 'top' | 'bottom', socketsFace: TopoShape | null, socketDepth: number, warn: Warn, report: Report) => {
    let board = as3D(prism(outlineFace, 0, thickness));
    let copper: Shape3D | null = null;
    const cf = copperFace(side, s.copperOffset);
    if (cf) {
      if (s.mode === 'recessed') {
        let d = s.traceDepth;
        if (d > thickness - 0.2) {
          d = Math.max(0.1, thickness - 0.2);
          warn(`Trace depth reduced to ${d.toFixed(2)} mm to leave a floor under the channels.`);
        }
        board = board.cut(as3D(prism(cf, thickness - d, d + 1)));
        if (s.channelChamfer > 0) board = chamferChannels(board, side, thickness, d, warn, report);
      } else {
        copper = as3D(prism(cf, thickness, s.traceHeight));
        if (s.channelChamfer > 0) copper = chamferRaised(copper, cf, side, thickness + s.traceHeight, warn, report);
      }
    } else {
      warn(`The ${side} copper layer is empty after clipping to the outline.`);
    }
    const silk = silkFace(side);
    if (silk) {
      const depth = Math.min(s.silkDepth, thickness - socketDepth - 0.3);
      if (s.silkMode === 'emboss' && s.mode === 'raised') board = board.fuse(as3D(prism(silk, thickness, s.silkDepth)));
      else if (depth > 0.05) {
        if (s.silkMode === 'emboss') warn('Embossed silkscreen would be sanded off in recessed mode; it is engraved instead.');
        board = board.cut(as3D(prism(silk, thickness - depth, depth + 1)));
      }
    }
    if (socketsFace) board = board.cut(as3D(prism(socketsFace, -1, socketDepth + 1)));
    if (holesSolid) {
      board = board.cut(as3D(holesSolid));
      if (copper) copper = copper.cut(as3D(holesSolid));
    }
    return { board, copper };
  };
  const slab = (thickness: number, side: 'top' | 'bottom', socketsFace: TopoShape | null, socketDepth: number, socketsKey = '') => {
    const featureH = s.mode === 'recessed' ? s.traceDepth : s.traceHeight;
    const chamfer = s.channelChamfer;
    const silkKey = key(s.silkMode, s.silkDepth, s.silkMinWidth, s.silkClearance);
    const k = key(outlineKey, holesKey, 'slab', thickness, side, s.mode, featureH, chamfer, s.copperOffset, socketsKey, socketDepth, silkKey);
    const r = staged(k, (warn, report) => buildSlab(thickness, side, socketsFace, socketDepth, warn, report));
    return { board: r.board.clone(), copper: r.copper ? r.copper.clone() : null };
  };

  const bodiesOf = (r: { board: Shape3D; copper: Shape3D | null }, label: string): Body[] => {
    if (r.copper && s.mergeBodies) return [{ name: label, shape: r.board.fuse(r.copper), color: COLORS.board }];
    const out: Body[] = [{ name: `${label} base`, shape: r.board, color: COLORS.board }];
    if (r.copper) out.push({ name: `${label} copper`, shape: r.copper, color: COLORS.copper });
    return out;
  };
  const mirrorBodies = (bodies: Body[]) => bodies.map((b) => ({ ...b, shape: mirrorX(b.shape) }));

  const parts: Part[] = [];
  let dowelPositions: Pt[] = [];
  let dowelLength = 0;
  const T = s.boardThickness;

  if (!doubleSided) {
    log('Building board');
    const r = slab(T, sides as 'top' | 'bottom', null, 0);
    let bodies = bodiesOf(r, 'Board');
    if (sides === 'bottom') bodies = mirrorBodies(bodies);
    parts.push({ id: 'board', label: PART_LABELS.board, bodies });
  } else {
    const half = T / 2;
    let socketsFace: TopoShape | null = null;
    let socketsKey = '';
    let depth = 0;
    if (s.alignmentDowels && s.dowelCount > 0) {
      depth = Math.min(s.dowelDepth, half - 0.3);
      if (depth < s.dowelDepth) warnings.push(`Dowel socket depth limited to ${depth.toFixed(2)} mm by the half thickness.`);
      if (depth >= 0.3) {
        const socketR = (s.dowelDiameter + s.dowelClearance) / 2;
        const avoid = s.mode === 'recessed' && s.traceDepth + depth > half - 0.2;
        dowelPositions = cache.get(key(outlineKey, 'dowels', s.dowelCount, socketR, s.dowelEdgeMargin, avoid), () =>
          placeDowels(shapes, bounds, input.drills, s.dowelCount, socketR, s.dowelEdgeMargin, avoid ? [...(input.top ?? []), ...(input.bottom ?? [])] : []),
        );
        if (dowelPositions.length < s.dowelCount) warnings.push(`Only ${dowelPositions.length} of ${s.dowelCount} dowel positions fit on the board.`);
        socketsKey = key('sockets', socketR, JSON.stringify(dowelPositions));
        socketsFace = cache.get(socketsKey, () => circlesFace(dowelPositions, socketR));
        dowelLength = Math.max(0.4, 2 * depth - 0.2);
      } else {
        warnings.push('Board halves are too thin for dowel sockets; dowels skipped.');
      }
    }
    log('Building top half');
    parts.push({ id: 'topHalf', label: PART_LABELS.topHalf, bodies: bodiesOf(slab(half, 'top', socketsFace, depth, socketsKey), 'Top half') });
    log('Building bottom half');
    parts.push({
      id: 'bottomHalf',
      label: PART_LABELS.bottomHalf,
      bodies: mirrorBodies(bodiesOf(slab(half, 'bottom', socketsFace, depth, socketsKey), 'Bottom half')),
    });
    if (dowelPositions.length) {
      const r = s.dowelDiameter / 2;
      const pins = dowelPositions.map((_, i) => makeCylinder(r, dowelLength, [bounds.maxX + 6 + r, bounds.minY + r + i * (2 * r + 3), 0]));
      const shape = pins.length === 1 ? pins[0] : as3D(cast(fuseAll(pins.map((p) => p.wrapped))));
      parts.push({ id: 'dowels', label: PART_LABELS.dowels, bodies: [{ name: 'Dowels', shape, color: COLORS.dowel }] });
    }
  }

  // ---- printability check ----
  if (s.printCheck) {
    const copperSides: ('top' | 'bottom')[] = doubleSided ? ['top', 'bottom'] : [sides as 'top' | 'bottom'];
    const n = s.nozzleDiameter;
    for (const side of copperSides) {
      staged(key(outlineKey, 'drc', side, s.copperOffset, n, s.minGap), (_warn, report) => {
        log(`Checking ${side} copper printability`);
        const prims = (side === 'top' ? input.top : input.bottom) ?? [];
        const opts = { nozzle: n, minGap: s.minGap, copperOffset: s.copperOffset };
        const found = [...narrowTraces(prims, opts)];
        const cf = copperFace(side, s.copperOffset);
        if (cf) {
          const eroded = copperFace(side, s.copperOffset - n + 1e-3);
          found.push(...vanishedRegions(cf, eroded, n, found.map((f) => f.at)));
          found.push(...narrowGaps(cf, s.minGap));
        }
        for (const f of found) report({ ...f, side });
      });
    }
    if (s.holes)
      staged(key(holesKey, 'drc-holes', n), (_warn, report) => {
        for (const h of smallHoles(input.drills, s.holeOffset, s.minHoleDiameter, n)) report({ ...h, side: copperSides[0] });
      });
    if (s.mode === 'recessed') {
      const floor = (doubleSided ? T / 2 : T) - s.traceDepth;
      if (floor < 0.3 + 1e-9) warnings.push(`Only ${floor.toFixed(2)} mm of material under the channels; use at least 0.3 mm.`);
    }
  }

  // ---- 2D cut patterns (vinyl cutter) ----
  const cutPatterns: Partial<Record<'top' | 'bottom', CutPattern>> = {};
  for (const side of (doubleSided ? ['top', 'bottom'] : [sides]) as ('top' | 'bottom')[]) {
    cutPatterns[side] = staged(key(outlineKey, holesKey, 'pattern', side, s.copperOffset), () => {
      const pattern: CutPattern = {
        copper: faceLoops(copperFace(side, s.copperOffset)),
        outline: faceLoops(outlineFace),
        holes: [],
        slots: [],
      };
      if (s.holes)
        for (const d of input.drills) {
          if (d.diameter < s.minHoleDiameter) continue;
          const r = (d.diameter + s.holeOffset) / 2;
          if (d.to) pattern.slots.push(slotLoop(d.at, d.to, r));
          else pattern.holes.push({ c: d.at, r });
        }
      // Bottom copper is printed mirrored (copper face up).
      return side === 'bottom' ? mapPattern(pattern, (q) => [2 * cx - q[0], q[1]]) : pattern;
    });
  }

  // ---- press stamps ----
  if (s.stampEnabled) {
    const stampSides: ('top' | 'bottom')[] = doubleSided ? ['top', 'bottom'] : [sides as 'top' | 'bottom'];
    for (const side of stampSides) {
      const stampKey = key(outlineKey, holesKey, 'stamp', side, s.mode, s.copperOffset, s.traceDepth, s.traceHeight, s.stampThickness, s.stampClearance,
        s.tapeThickness, s.stampFeatureOverride, s.alignmentPins, s.pinMinHoleDiameter, s.pinClearance, s.pinLength, s.cuttingRidge, s.ridgeWidth, s.ridgeHeight);
      const stamp = staged(stampKey, (warn) => {
        log(`Building ${side} stamp`);
        return buildStamp(side, warn);
      }).clone();
      // The stamp is flipped face-down onto the printed board face, so it is the mirror of that face.
      const boardFaceMirrored = side === 'bottom';
      const shape = boardFaceMirrored ? stamp : mirrorX(stamp);
      const id: PartId = side === 'top' ? 'stampTop' : 'stampBottom';
      parts.push({ id, label: PART_LABELS[id], bodies: [{ name: PART_LABELS[id], shape, color: COLORS.stamp }] });
    }
  }

  function buildStamp(side: 'top' | 'bottom', warn: Warn): Shape3D {
    let ts = s.stampThickness;
    const tape = s.tapeThickness;
    let stamp: Shape3D;
    let pinBase: number;
    let pinTop: number;
    if (s.mode === 'recessed') {
      const ribH = s.stampFeatureOverride > 0 ? s.stampFeatureOverride : Math.max(0.05, s.traceDepth - tape);
      const ribFace = copperFace(side, s.copperOffset - s.stampClearance);
      stamp = as3D(prism(outlineFace, 0, ts));
      if (ribFace) stamp = stamp.fuse(as3D(prism(ribFace, ts, ribH)));
      else warn(`The ${side} stamp has no ribs (copper too thin for the clearance).`);
      pinBase = ts;
      pinTop = ts + s.pinLength;
    } else {
      const depth = s.stampFeatureOverride > 0 ? s.stampFeatureOverride : s.traceHeight;
      if (ts < depth + 0.6) {
        ts = depth + 0.6;
        warn(`Stamp thickness increased to ${ts.toFixed(2)} mm to fit the pockets.`);
      }
      const c = s.copperOffset + s.stampClearance + tape;
      const pocketFace = copperFace(side, c);
      stamp = as3D(prism(outlineFace, 0, ts));
      if (pocketFace) stamp = stamp.cut(as3D(prism(pocketFace, ts - depth, depth + 1)));
      let ridge = 0;
      if (s.cuttingRidge && pocketFace && s.ridgeWidth > 0 && s.ridgeHeight > 0) {
        // Stepped ridge around each pocket rim: full width at the base, half width at the tip.
        const wide = copperFace(side, c + s.ridgeWidth);
        const narrow = copperFace(side, c + s.ridgeWidth / 2);
        const rh = s.ridgeHeight / 2;
        const ringA = wide ? cutAll(wide, [pocketFace]) : null;
        const ringB = narrow ? cutAll(narrow, [pocketFace]) : null;
        if (ringA && !isNullOrEmpty(ringA)) stamp = stamp.fuse(as3D(prism(unify(common(ringA, outlineFace)), ts, rh)));
        if (ringB && !isNullOrEmpty(ringB)) stamp = stamp.fuse(as3D(prism(unify(common(ringB, outlineFace)), ts + rh, rh)));
        ridge = s.ridgeHeight;
      }
      pinBase = ts - depth;
      pinTop = ts + ridge + s.pinLength;
    }
    if (s.alignmentPins && s.holes) {
      const byRadius = new Map<number, Pt[]>();
      for (const d of input.drills) {
        if (d.to || d.diameter < s.pinMinHoleDiameter) continue;
        const r = +((d.diameter + s.holeOffset - s.pinClearance) / 2).toFixed(4);
        if (r <= 0.2) continue;
        byRadius.set(r, [...(byRadius.get(r) ?? []), d.at]);
      }
      const pinFaces = [...byRadius].map(([r, pts]) => circlesFace(pts, r)).filter(Boolean);
      if (pinFaces.length) {
        const f = fuseAll(pinFaces);
        stamp = stamp.fuse(as3D(prism(f, pinBase, pinTop - pinBase)));
      } else {
        warn(`No holes ≥ ${s.pinMinHoleDiameter} mm for stamp alignment pins.`);
      }
    }
    return stamp;
  }

  return {
    name: input.name,
    parts,
    warnings: [...new Set(warnings)],
    doubleSided,
    bounds,
    dowelPositions,
    dowelLength,
    dowelDiameter: s.dowelDiameter,
    cacheHits: cache.hits,
    issues,
    cutPatterns,
  };
}

function rectContour(x0: number, y0: number, x1: number, y1: number): Contour {
  return {
    start: [x0, y0],
    segs: [
      { type: 'line', end: [x1, y0] },
      { type: 'line', end: [x1, y1] },
      { type: 'line', end: [x0, y1] },
      { type: 'line', end: [x0, y0] },
    ],
  };
}

function slotLoop(a: Pt, b: Pt, r: number): PathSeg[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / L;
  const uy = (b[1] - a[1]) / L;
  const nx = -uy * r;
  const ny = ux * r;
  const p = (q: Pt, sx: number, sy: number): Pt => [q[0] + sx, q[1] + sy];
  return [
    { type: 'line', a: p(a, nx, ny), b: p(b, nx, ny) },
    { type: 'arc', a: p(b, nx, ny), m: p(b, ux * r, uy * r), b: p(b, -nx, -ny) },
    { type: 'line', a: p(b, -nx, -ny), b: p(a, -nx, -ny) },
    { type: 'arc', a: p(a, -nx, -ny), m: p(a, -ux * r, -uy * r), b: p(a, nx, ny) },
  ];
}

/** The individual faces of a (compound) face shape. */
function faceList(shape: TopoShape): TopoShape[] {
  const OC = getOC() as any;
  const out: TopoShape[] = [];
  const exp = new OC.TopExp_Explorer(shape, OC.TopAbs_ShapeEnum.TopAbs_FACE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) out.push(OC.TopoDS.Face(exp.Current()));
  exp.delete();
  return out;
}

/**
 * Cut the edge chamfer tools of `loops` from `solid`. Tools of neighbouring edges are fused in small
 * batches (one cut per batch keeps big pours fast); a batch that fails is retried one tool at a time.
 * Never pass several tools to one cut: OpenCascade can silently do nothing then.
 */
function cutChamferTools(solid: TopoShape, loops: PathSeg[][], top: number, size: number, batch = 16): TopoShape {
  let cur = solid;
  for (const loop of loops) {
    const tools = edgeChamferTools([loop], top, size);
    for (let i = 0; i < tools.length; i += batch) {
      const chunk = tools.slice(i, i + batch);
      try {
        cur = cutAll(cur, [fuseAll(chunk)]);
      } catch {
        for (const t of chunk) cur = cutAll(cur, [t]);
      }
    }
  }
  return cur;
}
