// Filled zones left as leftover copper tape: which copper belongs to a zone's net. Found from geometry alone
// (each connected copper island is one net), so it works for Gerbers from any EDA tool, with or without net names.
import type { Primitive, Pt } from '../gerber/types';
import { distToPolyline, pointInPolygon, polygonArea } from '../gerber/geom2d';
import type { PathSeg } from '../export/paths2d';

/** Points within this distance of an island's boundary belong to it (primitive vertices lie on it). */
const ON_BOUNDARY = 1e-3;

/** A copper island as boundary polygons: counter-clockwise outer loop(s), clockwise holes. */
export type Island = Pt[][];

/** Boundary polygon of a loop, arcs sampled finely enough for point tests near round pads. */
export function loopPolygon(loop: PathSeg[]): Pt[] {
  const pts: Pt[] = [];
  for (const s of loop) {
    pts.push(s.a);
    if (s.type === 'arc') pts.push(...arcPoints(s.a, s.m, s.b, 8));
  }
  return pts;
}

/** Interior points of the arc through a, m, b (`n` pieces); falls back to m when the points are collinear. */
function arcPoints(a: Pt, m: Pt, b: Pt, n: number): Pt[] {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return [m];
  const sq = (p: Pt) => p[0] * p[0] + p[1] * p[1];
  const c: Pt = [
    (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d,
    (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d,
  ];
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const ang = (p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a);
  // Sweep from a to b in the direction that passes m.
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = norm(ang(m) - a0) < norm(ang(b) - a0);
  const sweep = ccw ? norm(ang(b) - a0) : -norm(a0 - ang(b));
  const out: Pt[] = [];
  for (let k = 1; k < n; k++) out.push([c[0] + r * Math.cos(a0 + (sweep * k) / n), c[1] + r * Math.sin(a0 + (sweep * k) / n)]);
  return out;
}

/** A point of the primitive's own copper. */
function anchor(p: Primitive): Pt {
  return p.kind === 'circle' ? p.center : p.kind === 'stroke' ? p.from : p.outer.start;
}

/** Index of the island holding `p` (inside, or on its boundary), -1 when none. */
export function islandOf(p: Pt, islands: Island[]): number {
  return islands.findIndex((loops) => {
    if (loops.some((l) => distToPolyline(p, l) <= ON_BOUNDARY)) return true;
    const inOuter = loops.some((l) => polygonArea(l) > 0 && pointInPolygon(p, l));
    return inOuter && !loops.some((l) => polygonArea(l) < 0 && pointInPolygon(p, l));
  });
}

export interface ZoneSplit {
  /** Copper that is still processed: everything not connected to a zone (clear-polarity shapes always). */
  kept: Primitive[];
  /** Indices of the islands that contain a zone. */
  zoneIslands: number[];
  /** Primitives dropped together with the zones (their pads, spokes, traces), the zones themselves excluded. */
  connected: number;
}

/** Drop the zones and all copper connected to them. `islands` are the islands of the merged layer. */
export function splitZones(prims: Primitive[], islands: Island[]): ZoneSplit {
  const owner = prims.map((p) => (p.dark ? islandOf(anchor(p), islands) : -1));
  const zoneIslands = new Set<number>();
  prims.forEach((p, i) => {
    if (p.kind === 'contour' && p.zone && owner[i] >= 0) zoneIslands.add(owner[i]);
  });
  const kept: Primitive[] = [];
  let connected = 0;
  prims.forEach((p, i) => {
    if (!zoneIslands.has(owner[i])) kept.push(p);
    else if (!(p.kind === 'contour' && p.zone)) connected++;
  });
  return { kept, zoneIslands: [...zoneIslands].sort((a, b) => a - b), connected };
}
