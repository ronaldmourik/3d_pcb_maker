// Builds the printable B-rep parts (board / halves / dowels / stamps) with OpenCascade.
import { cast, getOC, makeCompound, makeCylinder, makeFace, type AnyShape, type Face, type Shape3D } from 'replicad';
import type { BoardInput, Contour, Primitive, Pt } from '../gerber/types';
import { buildOutline, type OutlineShape } from '../gerber/outline';
import { addPt, contourPoints, drillsBounds, emptyBounds, isEmpty, polygonArea, primitivesBounds, type Bounds } from '../gerber/geom2d';
import { resolveSides, type Settings } from '../state/settings';
import { circlesFace, contourFace, drillsFace, layerFace, type FaceStats } from './faces';
import { common, cutAll, facesUp, fuseAll, isNullOrEmpty, isValid, offsetFace, prism, unify } from './occ';
import { placeDowels } from './dowels';
import { chamferTools, edgeChamferTools, type ChamferStats } from './chamfer';
import { GeometryCache, hashValue } from './cache';
import { narrowGaps, narrowTraces, smallHoles, vanishedRegions } from './printability';
import { faceLoops } from './paths';
import { estimateNets } from './resistance';
import { loopPolygon, splitZones } from './zones';
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
  /** Informational entries (e.g. resistance estimates) are listed but not marked as problems. */
  level?: 'info';
}

export type PartId = 'board' | 'topHalf' | 'bottomHalf' | 'dowels' | 'stampTop' | 'stampBottom';

export interface Body {
  name: string;
  shape: Shape3D;
  color: string;
  /** Material name for multi-material 3MF. */
  material?: string;
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
  /** Thin outline of the original Gerber copper per side (board coordinates, z 0..OVERLAY_H), preview only. */
  overlays: Partial<Record<'top' | 'bottom', Shape3D>>;
}

export const OVERLAY_H = 0.05;
const OVERLAY_W = 0.25;

export const COLORS = {
  board: '#ece8dc',
  copper: '#c87533',
  stamp: '#5b8dd9',
  dowel: '#8a8a8a',
  conductive: '#3a3a3a',
  issue: '#e53e3e',
  overlay: '#22c55e',
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
  for (const o of Object.values(r.overlays)) o?.delete();
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

  /** Filled zones left as leftover copper tape (only where tape stays on the surface). */
  const zonesOff = s.skipZones && (s.mode === 'groove' || s.mode === 'raised');

  // ---- outline ----
  // Every copper-dependent stage key derives from this one, so the zone toggle is part of it.
  const outlineKey = key('outline', s.outlineSource, s.margin, zonesOff);
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

  /**
   * Zones left as leftover copper: the zones and all copper connected to them (one island of the merged layer
   * is one net) are dropped. `fill` is those islands with their holes filled; its outline gets a separator.
   */
  const zoneSplit = (side: 'top' | 'bottom'): { prims: Primitive[]; fill: TopoShape | null; outlines: Pt[][]; zones: number; connected: number } =>
    cache.get(key('zones', side), () => {
      const prims = (side === 'top' ? input.top : input.bottom) ?? [];
      const none = { prims, fill: null, outlines: [], zones: 0, connected: 0 };
      if (!prims.some((p) => p.kind === 'contour' && p.zone)) return none;
      log(`Finding ${side} filled zones`);
      const merged = layerFace(prims, 0, { failed: 0 });
      if (!merged) return none;
      const faces = faceList(merged);
      const islands = faces.map((f) => faceLoops(f).map(loopPolygon));
      const split = splitZones(prims, islands);
      if (!split.zoneIslands.length) return none;
      const outlines = split.zoneIslands.flatMap((i) => islands[i].filter((l) => polygonArea(l) > 0));
      const fill = fuseAll(split.zoneIslands.map((i) => facesUp(makeFace((cast(faces[i]) as Face).outerWire()).wrapped)));
      return { prims: split.kept, fill, outlines, zones: split.zoneIslands.length, connected: split.connected };
    });
  if (zonesOff)
    for (const side of (doubleSided ? ['top', 'bottom'] : [sides]) as ('top' | 'bottom')[]) {
      const z = zoneSplit(side);
      if (z.zones)
        issues.push({
          level: 'info',
          side,
          at: z.outlines[0][0],
          message: `${z.zones} filled zone(s) and ${z.connected} connected pad(s)/trace(s) left as leftover copper, separated by a groove along the zone outline`,
        });
    }
  /** The copper primitives of a side that are processed. */
  const layerPrims = (side: 'top' | 'bottom'): Primitive[] => (zonesOff ? zoneSplit(side).prims : ((side === 'top' ? input.top : input.bottom) ?? []));

  /** Merged copper of one side grown by `offset`, clipped to the outline (shared, do not consume). */
  const copperFace = (side: 'top' | 'bottom', offset: number): TopoShape | null =>
    staged(key(outlineKey, 'copper', side, offset), (warn, report) => {
      const label = `Merging ${side} copper${offset ? ` (offset ${offset.toFixed(2)} mm)` : ''}`;
      log(label);
      const prims = layerPrims(side);
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
    const prims = layerPrims(side);
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
  /**
   * Zones left as leftover copper: the ring between two outward offsets of the zone outlines, so neighbouring
   * zones (and the zones and the rest) are cut apart in the tape. It never cuts into processed copper.
   */
  const zoneSeparator = (side: 'top' | 'bottom', inner: number, outer: number): TopoShape | null => {
    if (!zonesOff || outer <= inner) return null;
    const fill = zoneSplit(side).fill;
    if (!fill) return null;
    return staged(key(outlineKey, 'separator', side, inner, outer), () => {
      log(`Building ${side} zone separator`);
      const wide = offsetFace(fill, outer);
      if (!wide) return null;
      const narrow = Math.abs(inner) > 1e-9 ? offsetFace(fill, inner) : fill;
      let r = narrow ? cutAll(wide, [narrow]) : wide;
      const keep = copperFace(side, inner);
      if (keep) r = cutAll(r, [keep]);
      r = unify(common(r, outlineFace));
      return isNullOrEmpty(r) ? null : r;
    });
  };
  /** The ring between two outward copper offsets (plus the zone separators), clipped to the outline (null when empty). */
  const band = (side: 'top' | 'bottom', inner: number, outer: number): TopoShape | null => {
    if (outer <= inner) return null;
    const wide = copperFace(side, outer);
    const narrow = wide && copperFace(side, inner);
    let r: TopoShape | null = wide ? unify(common(narrow ? cutAll(wide, [narrow]) : wide, outlineFace)) : null;
    if (r && isNullOrEmpty(r)) r = null;
    const sep = zoneSeparator(side, inner, outer);
    if (sep) r = r ? unify(fuseAll([r, sep])) : sep;
    return r;
  };
  /** Groove depth, limited to leave a 0.2 mm floor. */
  const grooveDepth = (thickness: number) => (s.grooveDepth > thickness - 0.2 ? Math.max(0.1, thickness - 0.2) : s.grooveDepth);
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
      } else if (s.mode === 'groove') {
        // Flush traces with a tear groove around them: the stamp ridge presses copper tape into it.
        const d = grooveDepth(thickness);
        if (d < s.grooveDepth) warn(`Groove depth reduced to ${d.toFixed(2)} mm to leave a floor under the grooves.`);
        const ring = band(side, s.copperOffset, s.copperOffset + s.grooveWidth);
        if (ring) board = board.cut(as3D(prism(ring, thickness - d, d + 1)));
        else warn(`The ${side} groove is empty (groove width must be > 0).`);
      } else if (s.mode === 'conductive' && s.conductiveEmbed) {
        // Flush: the conductive traces fill pockets in the board (one print, two materials).
        let h = s.traceHeight;
        if (h > thickness - 0.3) {
          h = Math.max(0.1, thickness - 0.3);
          warn(`Conductive trace thickness reduced to ${h.toFixed(2)} mm to leave a floor under the traces.`);
        }
        board = board.cut(as3D(prism(cf, thickness - h, h + 1)));
        copper = as3D(prism(cf, thickness - h, h));
      } else {
        copper = as3D(prism(cf, thickness, s.traceHeight));
        if (s.channelChamfer > 0) copper = chamferRaised(copper, cf, side, thickness + s.traceHeight, warn, report);
      }
    } else if (!(zonesOff && zoneSplit(side).fill)) {
      warn(`The ${side} copper layer is empty after clipping to the outline.`);
    }
    // Zones left as leftover copper: a groove along their outlines. Groove mode gets it through band(); raised
    // mode cuts it as a knife guide. A side with nothing but zones still gets its separator here.
    if (zonesOff && (s.mode === 'raised' || !cf)) {
      const sep = s.mode === 'raised' ? zoneSeparator(side, s.copperOffset, s.copperOffset + s.grooveWidth) : band(side, s.copperOffset, s.copperOffset + s.grooveWidth);
      const d = grooveDepth(thickness);
      if (sep) board = board.cut(as3D(prism(sep, thickness - d, d + 1)));
    }
    const silk = silkFace(side);
    let silkBody: Shape3D | null = null;
    if (silk) {
      const depth = Math.min(s.silkDepth, thickness - socketDepth - 0.3);
      if (s.silkMode === 'emboss' && s.mode !== 'recessed' && s.mode !== 'groove') {
        const marks = as3D(prism(silk, thickness, s.silkDepth));
        if (s.silkSeparate) silkBody = marks;
        else board = board.fuse(marks);
      } else if (depth > 0.05) {
        if (s.silkMode === 'emboss')
          warn(
            s.mode === 'groove'
              ? 'Embossed silkscreen would lift the copper tape in cut groove mode; it is engraved instead.'
              : 'Embossed silkscreen would be sanded off in recessed mode; it is engraved instead.',
          );
        board = board.cut(as3D(prism(silk, thickness - depth, depth + 1)));
        // Separate filament: the marks fill the engraving flush (an inlay).
        if (s.silkSeparate) silkBody = as3D(prism(silk, thickness - depth, depth));
      }
    }
    if (socketsFace) board = board.cut(as3D(prism(socketsFace, -1, socketDepth + 1)));
    if (holesSolid) {
      board = board.cut(as3D(holesSolid));
      if (copper) copper = copper.cut(as3D(holesSolid));
      if (silkBody) silkBody = silkBody.cut(as3D(holesSolid));
    }
    return { board, copper, silk: silkBody };
  };
  const slab = (thickness: number, side: 'top' | 'bottom', socketsFace: TopoShape | null, socketDepth: number, socketsKey = '') => {
    const featureH = s.mode === 'recessed' ? s.traceDepth : s.mode === 'groove' ? key(s.grooveWidth, s.grooveDepth) : key(s.traceHeight, zonesOff ? key(s.grooveWidth, s.grooveDepth) : '');
    const chamfer = s.mode === 'groove' ? 0 : s.channelChamfer;
    const silkKey = key(s.silkMode, s.silkDepth, s.silkMinWidth, s.silkClearance, s.silkSeparate);
    const k = key(outlineKey, holesKey, 'slab', thickness, side, s.mode, featureH, chamfer, s.copperOffset, socketsKey, socketDepth, silkKey, s.mode === 'conductive' ? s.conductiveEmbed : '');
    const r = staged(k, (warn, report) => buildSlab(thickness, side, socketsFace, socketDepth, warn, report));
    return { board: r.board.clone(), copper: r.copper ? r.copper.clone() : null, silk: r.silk ? r.silk.clone() : null };
  };

  const conductive = s.mode === 'conductive';
  if (conductive && s.mergeBodies) warnings.push('Conductive traces are kept as a separate body (a second material), even with "merge bodies" on.');
  const bodiesOf = (r: { board: Shape3D; copper: Shape3D | null; silk: Shape3D | null }, label: string): Body[] => {
    // Separate silkscreen stays its own body (a second filament), even with "merge bodies" on.
    const silk: Body[] = r.silk ? [{ name: `${label} silkscreen`, shape: r.silk, color: s.silkColor, material: 'Silkscreen' }] : [];
    if (r.copper && s.mergeBodies && !conductive) return [{ name: label, shape: r.board.fuse(r.copper), color: COLORS.board, material: 'Board' }, ...silk];
    const out: Body[] = [{ name: `${label} base`, shape: r.board, color: COLORS.board, material: 'Board' }];
    if (r.copper)
      out.push(
        conductive
          ? { name: `${label} traces`, shape: r.copper, color: COLORS.conductive, material: 'Conductive' }
          : { name: `${label} copper`, shape: r.copper, color: COLORS.copper, material: 'Copper' },
      );
    return [...out, ...silk];
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
        const featureDepth = s.mode === 'recessed' ? s.traceDepth : s.mode === 'groove' || zonesOff ? s.grooveDepth : 0;
        const avoid = featureDepth > 0 && featureDepth + depth > half - 0.2;
        const avoidGap = avoid && (s.mode === 'groove' || zonesOff) ? Math.max(0, s.copperOffset + s.grooveWidth) : 0;
        // Raised copper sits on top and needs no keep-out; zone separators always cut into the board.
        const avoidPrims = (): Primitive[] => [
          ...(s.mode === 'raised' ? [] : [...layerPrims('top'), ...layerPrims('bottom')]),
          ...(zonesOff ? (['top', 'bottom'] as const).flatMap((side) => zoneSplit(side).outlines.flatMap(outlineStrokes)) : []),
        ];
        dowelPositions = cache.get(key(outlineKey, 'dowels', s.dowelCount, socketR, s.dowelEdgeMargin, avoid, avoidGap), () =>
          placeDowels(shapes, bounds, input.drills, s.dowelCount, socketR, s.dowelEdgeMargin, avoid ? avoidPrims() : [], avoidGap),
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
      const minFeature = conductive ? Math.max(2 * n, s.conductiveMinWidth) : 2 * n;
      staged(key(outlineKey, 'drc', side, s.copperOffset, n, s.minGap, minFeature), (_warn, report) => {
        log(`Checking ${side} copper printability`);
        const prims = layerPrims(side);
        const opts = { nozzle: n, minGap: s.minGap, copperOffset: s.copperOffset, minFeature };
        const found = [...narrowTraces(prims, opts)];
        const cf = copperFace(side, s.copperOffset);
        if (cf) {
          const eroded = copperFace(side, s.copperOffset - minFeature / 2 + 1e-3);
          found.push(...vanishedRegions(cf, eroded, minFeature / 2, found.map((f) => f.at)));
          found.push(...narrowGaps(cf, s.minGap));
        }
        for (const f of found) report({ ...f, side });
      });
    }
    if (s.holes)
      staged(key(holesKey, 'drc-holes', n), (_warn, report) => {
        for (const h of smallHoles(input.drills, s.holeOffset, s.minHoleDiameter, n)) report({ ...h, side: copperSides[0] });
      });
    if (s.mode === 'recessed' || s.mode === 'groove') {
      const floor = (doubleSided ? T / 2 : T) - (s.mode === 'groove' ? s.grooveDepth : s.traceDepth);
      if (floor < 0.3 + 1e-9) warnings.push(`Only ${floor.toFixed(2)} mm of material under the ${s.mode === 'groove' ? 'grooves' : 'channels'}; use at least 0.3 mm.`);
    }
    if (s.mode === 'groove' && s.stampEnabled && s.grooveWidth - 2 * s.stampClearance < n)
      warnings.push(`The stamp ridge (${(s.grooveWidth - 2 * s.stampClearance).toFixed(2)} mm) is narrower than the nozzle; widen the groove.`);
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

  // ---- conductive: resistance per net ----
  if (conductive) {
    for (const side of (doubleSided ? ['top', 'bottom'] : [sides]) as ('top' | 'bottom')[]) {
      staged(key(outlineKey, 'nets', side, s.copperOffset, s.conductiveResistivity, s.traceHeight), (_warn, report) => {
        const cf = copperFace(side, s.copperOffset);
        if (!cf) return;
        const prims = layerPrims(side);
        const islands = faceList(cf).map((f) => faceLoops(f));
        const nets = estimateNets(prims, islands, s.conductiveResistivity, s.traceHeight, s.copperOffset).sort((a, b) => b.resistance - a.resistance);
        for (const net of nets)
          report({
            level: 'info',
            side,
            at: net.at,
            message: `Net: ${net.length.toFixed(1)} mm of trace (min ${net.minWidth.toFixed(2)} mm wide), up to ${formatOhm(net.resistance)}`,
          });
      });
    }
  }

  // ---- Gerber overlay (preview only): a thin ring along the original copper outline ----
  const overlays: Partial<Record<'top' | 'bottom', Shape3D>> = {};
  for (const side of (doubleSided ? ['top', 'bottom'] : [sides]) as ('top' | 'bottom')[]) {
    const ring = staged(key(outlineKey, 'overlay', side), () => {
      const full = copperFace(side, 0);
      const inner = copperFace(side, -OVERLAY_W);
      if (!full) return null;
      const r = inner ? cutAll(full, [inner]) : full;
      return isNullOrEmpty(r) ? null : as3D(prism(r, 0, OVERLAY_H));
    });
    if (ring) overlays[side] = ring.clone();
  }

  // ---- press stamps ----
  if (s.mode === 'groove' && !s.stampEnabled) warnings.push('Cut groove mode is meant for the press stamp; enable it to tear the tape along the grooves.');
  if (s.stampEnabled && !conductive) {
    const stampSides: ('top' | 'bottom')[] = doubleSided ? ['top', 'bottom'] : [sides as 'top' | 'bottom'];
    for (const side of stampSides) {
      const stampKey = key(outlineKey, holesKey, 'stamp', side, s.mode, s.copperOffset, s.traceDepth, s.traceHeight, s.stampThickness, s.stampClearance,
        s.tapeThickness, s.stampFeatureOverride, s.alignmentPins, s.pinMinHoleDiameter, s.pinClearance, s.pinLength, s.cuttingRidge, s.ridgeWidth, s.ridgeHeight, s.grooveWidth, s.grooveDepth, s.grooveRidgeStepped, s.boardThickness, doubleSided);
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
    } else if (s.mode === 'groove') {
      // Ridge into the groove: square, or stepped with its narrow tip against the trace edge where the tape should tear.
      const d = grooveDepth(doubleSided ? s.boardThickness / 2 : s.boardThickness);
      const rh = s.stampFeatureOverride > 0 ? s.stampFeatureOverride : d;
      const inner = s.copperOffset + s.stampClearance;
      const w = s.grooveWidth - 2 * s.stampClearance;
      stamp = as3D(prism(outlineFace, 0, ts));
      let ridge = 0;
      if (w > 0) {
        const base = band(side, inner, inner + w);
        if (s.grooveRidgeStepped) {
          const tip = band(side, inner, inner + w / 2);
          if (base) stamp = stamp.fuse(as3D(prism(base, ts, rh / 2)));
          if (tip) stamp = stamp.fuse(as3D(prism(tip, ts + rh / 2, rh / 2)));
        } else if (base) {
          stamp = stamp.fuse(as3D(prism(base, ts, rh)));
        }
        if (base) ridge = rh;
        else warn(`The ${side} stamp has no ridge (copper layer empty).`);
      } else {
        warn(`The ${side} stamp has no ridge: the groove (${s.grooveWidth} mm) is not wider than twice the stamp clearance.`);
      }
      pinBase = ts;
      pinTop = ts + ridge + s.pinLength;
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
    overlays,
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
/** A closed polygon as zero-width strokes (an obstacle line for dowel placement). */
function outlineStrokes(poly: Pt[]): Primitive[] {
  return poly.map((p, i) => ({ kind: 'stroke', dark: true, from: p, seg: { type: 'line', end: poly[(i + 1) % poly.length] }, width: 0 }));
}

export function faceList(shape: TopoShape): TopoShape[] {
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

function formatOhm(r: number): string {
  if (r >= 1e6) return `${(r / 1e6).toFixed(1)} MΩ`;
  if (r >= 1e3) return `${(r / 1e3).toFixed(1)} kΩ`;
  return `${r.toFixed(r < 10 ? 1 : 0)} Ω`;
}
