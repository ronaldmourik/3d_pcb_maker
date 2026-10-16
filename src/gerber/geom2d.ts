// Plain 2D helpers on discretized contours (used for nesting, placement and bounds).
import type { Contour, Drill, Primitive, Pt } from './types';
import { arcSweep } from './gerber';

/** Discretize a contour into a polyline (closed, without repeating the start point). */
export function contourPoints(c: Contour, maxAngle = Math.PI / 18): Pt[] {
  const pts: Pt[] = [c.start];
  let cur = c.start;
  for (const s of c.segs) {
    if (s.type === 'line') {
      pts.push(s.end);
    } else {
      const sweep = arcSweep(cur, s.end, s.center, s.cw);
      const r = Math.hypot(cur[0] - s.center[0], cur[1] - s.center[1]);
      const a0 = Math.atan2(cur[1] - s.center[1], cur[0] - s.center[0]);
      const n = Math.max(2, Math.ceil(sweep / maxAngle));
      for (let k = 1; k <= n; k++) {
        const a = a0 + (s.cw ? -1 : 1) * (sweep * k) / n;
        pts.push([s.center[0] + r * Math.cos(a), s.center[1] + r * Math.sin(a)]);
      }
    }
    cur = s.end;
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last[0] - c.start[0], last[1] - c.start[1]) < 1e-9) pts.pop();
  return pts;
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distPointSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToPolyline(p: Pt, poly: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distPointSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function addPt(b: Bounds, p: Pt, pad = 0) {
  b.minX = Math.min(b.minX, p[0] - pad);
  b.minY = Math.min(b.minY, p[1] - pad);
  b.maxX = Math.max(b.maxX, p[0] + pad);
  b.maxY = Math.max(b.maxY, p[1] + pad);
}

export function isEmpty(b: Bounds) {
  return !(b.maxX >= b.minX && b.maxY >= b.minY);
}

export function primitivesBounds(prims: Primitive[], b: Bounds = emptyBounds()): Bounds {
  for (const p of prims) {
    if (!p.dark) continue;
    if (p.kind === 'circle') addPt(b, p.center, p.r);
    else if (p.kind === 'stroke') {
      addPt(b, p.from, p.width / 2);
      addPt(b, p.seg.end, p.width / 2);
      if (p.seg.type === 'arc') {
        for (const q of contourPoints({ start: p.from, segs: [p.seg] })) addPt(b, q, p.width / 2);
      }
    } else for (const q of contourPoints(p.outer)) addPt(b, q);
  }
  return b;
}

export function drillsBounds(drills: Drill[], b: Bounds = emptyBounds()): Bounds {
  for (const d of drills) {
    addPt(b, d.at, d.diameter / 2);
    if (d.to) addPt(b, d.to, d.diameter / 2);
  }
  return b;
}
