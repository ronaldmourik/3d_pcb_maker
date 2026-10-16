// Converts exact 2D primitives into OpenCascade planar faces (arcs stay arcs).
import { draw, drawCircle, makeFace, type Drawing, type Wire } from 'replicad';
import type { Contour, Drill, Primitive, Pt } from '../gerber/types';
import { arcSweep, samePt } from '../gerber/gerber';
import { cutAll, drawingFace, facesUp, fuseAll, unify } from './occ';
import { contourPoints, polygonArea } from '../gerber/geom2d';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TopoShape = any;

const EPS = 1e-4;

const polar = (c: Pt, r: number, a: number): Pt => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

export function contourDrawing(c: Contour): Drawing {
  const pen = draw(c.start);
  let cur = c.start;
  for (const s of c.segs) {
    if (samePt(cur, s.end, EPS) && s.type === 'line') continue;
    if (s.type === 'line') {
      pen.lineTo(s.end);
    } else {
      const sweep = arcSweep(cur, s.end, s.center, s.cw);
      const r = Math.hypot(cur[0] - s.center[0], cur[1] - s.center[1]);
      const a0 = Math.atan2(cur[1] - s.center[1], cur[0] - s.center[0]);
      const dir = s.cw ? -1 : 1;
      // Split into pieces of at most 180° so three-point arcs are well defined.
      const pieces = Math.max(1, Math.ceil(sweep / Math.PI - 1e-9));
      for (let k = 0; k < pieces; k++) {
        const aMid = a0 + (dir * sweep * (k + 0.5)) / pieces;
        const aEnd = a0 + (dir * sweep * (k + 1)) / pieces;
        const end = k === pieces - 1 ? s.end : polar(s.center, r, aEnd);
        pen.threePointsArcTo(end, polar(s.center, r, aMid));
      }
    }
    cur = s.end;
  }
  return pen.close();
}

export function circleDrawing(c: Pt, r: number): Drawing {
  return drawCircle(r).translate(c[0], c[1]);
}

export function stadium(a: Pt, b: Pt, h: number): Drawing {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < EPS) return circleDrawing(a, h);
  const ux = dx / L;
  const uy = dy / L;
  const nx = -uy * h;
  const ny = ux * h;
  return draw([a[0] + nx, a[1] + ny])
    .lineTo([b[0] + nx, b[1] + ny])
    .threePointsArcTo([b[0] - nx, b[1] - ny], [b[0] + ux * h, b[1] + uy * h])
    .lineTo([a[0] - nx, a[1] - ny])
    .threePointsArcTo([a[0] + nx, a[1] + ny], [a[0] - ux * h, a[1] - uy * h])
    .close();
}

/** Annular band along an arc (≤ 90° pieces) with round caps. */
export function arcBand(c: Pt, r: number, a0: number, a1: number, h: number): Drawing {
  const ccw = a1 > a0;
  const s = ccw ? 1 : -1;
  const ro = r + h;
  const ri = r - h;
  const am = (a0 + a1) / 2;
  const tan = (a: number): Pt => [-Math.sin(a) * s, Math.cos(a) * s];
  const e1 = polar(c, r, a1);
  const e0 = polar(c, r, a0);
  const t1 = tan(a1);
  const t0 = tan(a0);
  return draw(polar(c, ro, a0))
    .threePointsArcTo(polar(c, ro, a1), polar(c, ro, am))
    .threePointsArcTo(polar(c, ri, a1), [e1[0] + t1[0] * h, e1[1] + t1[1] * h])
    .threePointsArcTo(polar(c, ri, a0), polar(c, ri, am))
    .threePointsArcTo(polar(c, ro, a0), [e0[0] - t0[0] * h, e0[1] - t0[1] * h])
    .close();
}

/** Drawings for one primitive, grown by `offset` (negative shrinks). */
export function primitiveDrawings(p: Primitive, offset: number): Drawing[] {
  switch (p.kind) {
    case 'circle': {
      const r = p.r + offset;
      return r > EPS ? [circleDrawing(p.center, r)] : [];
    }
    case 'stroke': {
      const h = p.width / 2 + offset;
      if (h <= EPS) return [];
      if (p.seg.type === 'line') return [stadium(p.from, p.seg.end, h)];
      const { center, cw } = p.seg;
      const r = Math.hypot(p.from[0] - center[0], p.from[1] - center[1]);
      const sweep = arcSweep(p.from, p.seg.end, center, cw);
      const a0 = Math.atan2(p.from[1] - center[1], p.from[0] - center[0]);
      const dir = cw ? -1 : 1;
      const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
      const out: Drawing[] = [];
      for (let k = 0; k < n; k++) {
        const s0 = a0 + (dir * sweep * k) / n;
        const s1 = a0 + (dir * sweep * (k + 1)) / n;
        if (r - h > EPS) out.push(arcBand(center, r, s0, s1, h));
        else out.push(stadium(polar(center, r, s0), polar(center, r, s1), h)); // tiny radius: chord approximation
      }
      return out;
    }
    case 'contour': {
      let d = contourDrawing(p.outer);
      for (const hole of p.holes ?? []) d = d.cut(contourDrawing(hole));
      if (Math.abs(offset) > EPS) {
        try {
          d = d.offset(offset, { lineJoinType: 'round' });
        } catch {
          // Shrinking can make a shape vanish entirely; growing should never fail, keep the original then.
          if (offset < 0) return [];
        }
      }
      return [d];
    }
  }
}

export interface FaceStats {
  failed: number;
  /** A point of every primitive that could not be converted. */
  failedAt?: Pt[];
}

export type Progress = (done: number, total: number) => void;

/** A representative point of a primitive (for locating problems). */
export function primitivePoint(p: Primitive): Pt {
  return p.kind === 'circle' ? p.center : p.kind === 'stroke' ? p.from : p.outer.start;
}

/** Fuse/cut all primitives of a layer in order of polarity into one face set. */
export function layerFace(prims: Primitive[], offset: number, stats: FaceStats, progress?: Progress): TopoShape | null {
  let acc: TopoShape | null = null;
  let i = 0;
  while (i < prims.length) {
    const dark = prims[i].dark;
    const faces: TopoShape[] = [];
    while (i < prims.length && prims[i].dark === dark) {
      const o = dark ? offset : -offset;
      try {
        faces.push(...primitiveFaces(prims[i], o));
      } catch {
        // A shape shrunk to nothing is expected, not a failure.
        if (o >= 0) {
          stats.failed++;
          (stats.failedAt ??= []).push(primitivePoint(prims[i]));
        }
      }
      i++;
      if (progress && (i % 50 === 0 || i === prims.length)) progress(i, prims.length);
    }
    if (!faces.length) continue;
    if (dark) acc = fuseAll(acc ? [acc, ...faces] : faces);
    else if (acc) acc = cutAll(acc, [fuseAll(faces)]);
  }
  return acc ? unify(acc) : null;
}

export function drillDrawing(d: Drill, diameter: number): Drawing {
  const r = diameter / 2;
  if (d.to && !samePt(d.at, d.to, EPS)) return stadium(d.at, d.to, r);
  return circleDrawing(d.at, r);
}

export function drillsFace(drills: Drill[], offset: number, minDiameter: number): TopoShape | null {
  const faces: TopoShape[] = [];
  for (const d of drills) {
    if (d.diameter < minDiameter) continue;
    const dia = d.diameter + offset;
    if (dia <= EPS) continue;
    faces.push(drawingFace(drillDrawing(d, dia)));
  }
  return faces.length ? fuseAll(faces) : null;
}

export function contourFace(outer: Contour, holes: Contour[]): TopoShape {
  let d = contourDrawing(outer);
  for (const h of holes) d = d.cut(contourDrawing(h));
  return drawingFace(d);
}

export function circlesFace(centers: Pt[], r: number): TopoShape | null {
  const faces = centers.map((c) => drawingFace(circleDrawing(c, r)));
  return faces.length ? fuseAll(faces) : null;
}

/** Faces of one primitive. Regions with many holes (pours) are built straight from wires: much faster. */
export function primitiveFaces(p: Primitive, offset: number): TopoShape[] {
  if (p.kind === 'contour' && p.holes?.length && Math.abs(offset) <= EPS) {
    const wire = (c: Contour, ccw: boolean) => {
      const isCcw = polygonArea(contourPoints(c)) > 0;
      return (contourDrawing(isCcw === ccw ? c : reverseContour(c)).sketchOnPlane('XY') as unknown as { wire: Wire }).wire;
    };
    return [facesUp(makeFace(wire(p.outer, true), p.holes.map((h) => wire(h, false))).wrapped)];
  }
  return primitiveDrawings(p, offset).map(drawingFace);
}

export function reverseContour(c: Contour): Contour {
  const pts: Pt[] = [c.start, ...c.segs.map((s) => s.end)];
  const segs: Contour['segs'] = [];
  for (let i = c.segs.length - 1; i >= 0; i--) {
    const s = c.segs[i];
    const end = pts[i];
    segs.push(s.type === 'line' ? { type: 'line', end } : { type: 'arc', end, center: s.center, cw: !s.cw });
  }
  return { start: pts[pts.length - 1], segs };
}
