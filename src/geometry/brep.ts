// Builds the printable B-rep parts (board / halves / dowels / stamps) with OpenCascade.
import { cast, makeCylinder, type AnyShape, type Shape3D } from 'replicad';
import type { BoardInput, Contour, Pt } from '../gerber/types';
import { buildOutline, type OutlineShape } from '../gerber/outline';
import { addPt, contourPoints, drillsBounds, emptyBounds, isEmpty, primitivesBounds, type Bounds } from '../gerber/geom2d';
import { resolveSides, type Settings } from '../state/settings';
import { circlesFace, contourFace, drillsFace, layerFace, type FaceStats } from './faces';
import { common, cutAll, fuseAll, isNullOrEmpty, isValid, prism, unify } from './occ';
import { placeDowels } from './dowels';
import { chamferTools, type ChamferStats } from './chamfer';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TopoShape = any;

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
}

export const COLORS = {
  board: '#ece8dc',
  copper: '#c87533',
  stamp: '#5b8dd9',
  dowel: '#8a8a8a',
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

export function buildModel(input: BoardInput, s: Settings, log: (msg: string) => void = () => {}): BuildResult {
  const warnings: string[] = [];
  const hasTop = !!input.top?.some((p) => p.dark);
  const hasBottom = !!input.bottom?.some((p) => p.dark);
  const sides = resolveSides(s.sides, hasTop, hasBottom);
  if (!sides) throw new Error('No copper layer found. Upload a top and/or bottom copper Gerber.');
  if (sides !== s.sides) warnings.push(`Only the ${sides} copper layer is available; generating a single-sided board.`);
  const doubleSided = sides === 'both';

  // ---- outline ----
  log('Building outline');
  let shapes: OutlineShape[] = [];
  if (s.outlineSource === 'edge-cuts') {
    if (input.outline?.length) {
      const r = buildOutline(input.outline);
      shapes = r.shapes;
      if (r.openSegments) warnings.push(`${r.openSegments} outline segment(s) did not form a closed loop and were ignored.`);
      if (!shapes.length) warnings.push('Outline layer has no closed contour; using the bounding box instead.');
    } else {
      warnings.push('No outline (Edge.Cuts) layer; using the copper bounding box.');
    }
  }
  if (!shapes.length) {
    const b = emptyBounds();
    if (hasTop) primitivesBounds(input.top!, b);
    if (hasBottom) primitivesBounds(input.bottom!, b);
    drillsBounds(input.drills, b);
    if (isEmpty(b)) throw new Error('Nothing to build: the layers are empty.');
    const m = s.margin;
    shapes = [{ outer: rectContour(b.minX - m, b.minY - m, b.maxX + m, b.maxY + m), holes: [] }];
  }
  const bounds = emptyBounds();
  for (const sh of shapes) for (const p of contourPoints(sh.outer)) addPt(bounds, p);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const outlineFace = unify(fuseAll(shapes.map((sh) => contourFace(sh.outer, sh.holes))));

  const stats: FaceStats = { failed: 0 };
  const copperFaceCache = new Map<string, TopoShape | null>();
  const copperFace = (side: 'top' | 'bottom', offset: number): TopoShape | null => {
    const key = `${side}:${offset.toFixed(5)}`;
    if (copperFaceCache.has(key)) return copperFaceCache.get(key)!;
    log(`Merging ${side} copper (offset ${offset.toFixed(2)} mm)`);
    const prims = (side === 'top' ? input.top : input.bottom) ?? [];
    let f = layerFace(prims, offset, stats);
    if (f) {
      f = unify(common(f, outlineFace));
      if (isNullOrEmpty(f)) f = null;
    }
    copperFaceCache.set(key, f);
    return f;
  };

  log('Building holes');
  const holesFace = s.holes ? drillsFace(input.drills, s.holeOffset, s.minHoleDiameter) : null;
  const holesSolid = holesFace ? prism(holesFace, -50, 200) : null;
  const mirrorX = <T extends AnyShape>(shape: T): T => shape.mirror('YZ', [cx, 0, 0]) as T;

  /** Chamfer the top rim of the recessed channels (before drilling, so holes stay sharp). */
  const chamferChannels = (board: Shape3D, side: 'top' | 'bottom', top: number, depth: number): Shape3D => {
    const size = Math.min(s.channelChamfer, depth - 0.05);
    if (size < s.channelChamfer) warnings.push(`Channel chamfer limited to ${size.toFixed(2)} mm by the channel depth.`);
    if (size <= 0.01) return board;
    log(`Chamfering ${side} channels`);
    const prims = (side === 'top' ? input.top : input.bottom) ?? [];
    const cs: ChamferStats = { lofted: 0, stepped: 0, failed: 0 };
    try {
      const tools = chamferTools(prims, s.copperOffset, top, size, cs);
      const chamfered = as3D(cast(cutAll(board.wrapped, tools)));
      if (cs.stepped) warnings.push(`${cs.stepped} irregular copper shape(s) got a stepped chamfer approximation.`);
      if (cs.failed) warnings.push(`${cs.failed} copper shape(s) could not be chamfered.`);
      if (isValid(chamfered.wrapped)) return chamfered;
    } catch {
      /* fall through */
    }
    warnings.push('Channel chamfer failed; channels left sharp.');
    return board;
  };

  // ---- board / halves ----
  const slab = (thickness: number, side: 'top' | 'bottom', socketsFace: TopoShape | null, socketDepth: number) => {
    let board = as3D(prism(outlineFace, 0, thickness));
    let copper: Shape3D | null = null;
    const cf = copperFace(side, s.copperOffset);
    if (cf) {
      if (s.mode === 'recessed') {
        let d = s.traceDepth;
        if (d > thickness - 0.2) {
          d = Math.max(0.1, thickness - 0.2);
          warnings.push(`Trace depth reduced to ${d.toFixed(2)} mm to leave a floor under the channels.`);
        }
        board = board.cut(as3D(prism(cf, thickness - d, d + 1)));
        if (s.channelChamfer > 0) board = chamferChannels(board, side, thickness, d);
      } else {
        copper = as3D(prism(cf, thickness, s.traceHeight));
      }
    } else {
      warnings.push(`The ${side} copper layer is empty after clipping to the outline.`);
    }
    if (socketsFace) board = board.cut(as3D(prism(socketsFace, -1, socketDepth + 1)));
    if (holesSolid) {
      board = board.cut(as3D(holesSolid));
      if (copper) copper = copper.cut(as3D(holesSolid));
    }
    return { board, copper };
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
    let depth = 0;
    if (s.alignmentDowels && s.dowelCount > 0) {
      depth = Math.min(s.dowelDepth, half - 0.3);
      if (depth < s.dowelDepth) warnings.push(`Dowel socket depth limited to ${depth.toFixed(2)} mm by the half thickness.`);
      if (depth >= 0.3) {
        const socketR = (s.dowelDiameter + s.dowelClearance) / 2;
        const avoid = s.mode === 'recessed' && s.traceDepth + depth > half - 0.2;
        dowelPositions = placeDowels(shapes, bounds, input.drills, s.dowelCount, socketR, s.dowelEdgeMargin, avoid ? [...(input.top ?? []), ...(input.bottom ?? [])] : []);
        if (dowelPositions.length < s.dowelCount)
          warnings.push(`Only ${dowelPositions.length} of ${s.dowelCount} dowel positions fit on the board.`);
        socketsFace = circlesFace(dowelPositions, socketR);
        dowelLength = Math.max(0.4, 2 * depth - 0.2);
      } else {
        warnings.push('Board halves are too thin for dowel sockets; dowels skipped.');
      }
    }
    log('Building top half');
    parts.push({ id: 'topHalf', label: PART_LABELS.topHalf, bodies: bodiesOf(slab(half, 'top', socketsFace, depth), 'Top half') });
    log('Building bottom half');
    parts.push({
      id: 'bottomHalf',
      label: PART_LABELS.bottomHalf,
      bodies: mirrorBodies(bodiesOf(slab(half, 'bottom', socketsFace, depth), 'Bottom half')),
    });
    if (dowelPositions.length) {
      const r = s.dowelDiameter / 2;
      const pins = dowelPositions.map((_, i) =>
        makeCylinder(r, dowelLength, [bounds.maxX + 6 + r, bounds.minY + r + i * (2 * r + 3), 0]),
      );
      const shape = pins.length === 1 ? pins[0] : as3D(cast(fuseAll(pins.map((p) => p.wrapped))));
      parts.push({ id: 'dowels', label: PART_LABELS.dowels, bodies: [{ name: 'Dowels', shape, color: COLORS.dowel }] });
    }
  }

  // ---- press stamps ----
  if (s.stampEnabled) {
    const stampSides: ('top' | 'bottom')[] = doubleSided ? ['top', 'bottom'] : [sides as 'top' | 'bottom'];
    for (const side of stampSides) {
      log(`Building ${side} stamp`);
      const stamp = buildStamp(side);
      if (!stamp) continue;
      // The stamp is flipped face-down onto the printed board face, so it is the mirror of that face.
      const boardFaceMirrored = side === 'bottom';
      const shape = boardFaceMirrored ? stamp : mirrorX(stamp);
      const id: PartId = side === 'top' ? 'stampTop' : 'stampBottom';
      parts.push({ id, label: PART_LABELS[id], bodies: [{ name: PART_LABELS[id], shape, color: COLORS.stamp }] });
    }
  }

  function buildStamp(side: 'top' | 'bottom'): Shape3D | null {
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
      else warnings.push(`The ${side} stamp has no ribs (copper too thin for the clearance).`);
      pinBase = ts;
      pinTop = ts + s.pinLength;
    } else {
      const depth = s.stampFeatureOverride > 0 ? s.stampFeatureOverride : s.traceHeight;
      if (ts < depth + 0.6) {
        ts = depth + 0.6;
        warnings.push(`Stamp thickness increased to ${ts.toFixed(2)} mm to fit the pockets.`);
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
        warnings.push(`No holes ≥ ${s.pinMinHoleDiameter} mm for stamp alignment pins.`);
      }
    }
    return stamp;
  }

  if (stats.failed) warnings.push(`${stats.failed} copper primitive(s) could not be converted and were skipped.`);
  return {
    name: input.name,
    parts,
    warnings: [...new Set(warnings)],
    doubleSided,
    bounds,
    dowelPositions,
    dowelLength,
    dowelDiameter: s.dowelDiameter,
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
