// Picks positions for alignment dowels between the two halves of a double-sided board.
import type { Drill, Primitive, Pt } from '../gerber/types';
import type { OutlineShape } from '../gerber/outline';
import { contourPoints, distPointSegment, distToPolyline, pointInPolygon, type Bounds } from '../gerber/geom2d';

export function placeDowels(
  shapes: OutlineShape[],
  bounds: Bounds,
  drills: Drill[],
  count: number,
  socketRadius: number,
  margin: number,
  copper: Primitive[] = [],
  /** Extra distance to keep from the copper (e.g. the groove around it). */
  copperClearance = 0,
): Pt[] {
  const obstacles = copper.filter((c) => c.dark);
  const regions = shapes.map((s) => ({ outer: contourPoints(s.outer), holes: s.holes.map((h) => contourPoints(h)) }));
  if (!regions.length) {
    const { minX, minY, maxX, maxY } = bounds;
    regions.push({ outer: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], holes: [] });
  }
  const clearance = socketRadius + margin;

  const valid = (p: Pt, chosen: Pt[]) => {
    const region = regions.find((r) => pointInPolygon(p, r.outer) && !r.holes.some((h) => pointInPolygon(p, h)));
    if (!region) return false;
    if (distToPolyline(p, region.outer) < clearance) return false;
    if (region.holes.some((h) => distToPolyline(p, h) < clearance)) return false;
    for (const d of drills) {
      const dist = d.to ? distPointSegment(p, d.at, d.to) : Math.hypot(p[0] - d.at[0], p[1] - d.at[1]);
      if (dist < clearance + d.diameter / 2) return false;
    }
    for (const c of obstacles) if (distToPrimitive(p, c) < clearance + copperClearance) return false;
    return chosen.every((c) => Math.hypot(p[0] - c[0], p[1] - c[1]) >= 2 * socketRadius + margin * 2);
  };

  const { minX, minY, maxX, maxY } = bounds;
  const targets: Pt[] = [
    [minX, minY],
    [maxX, maxY],
    [minX, maxY],
    [maxX, minY],
    [(minX + maxX) / 2, minY],
    [(minX + maxX) / 2, maxY],
    [minX, (minY + maxY) / 2],
    [maxX, (minY + maxY) / 2],
  ].slice(0, Math.max(0, Math.min(8, count))) as Pt[];

  const step = Math.max(0.25, Math.max(maxX - minX, maxY - minY) / 150);
  const grid: Pt[] = [];
  for (let x = minX; x <= maxX; x += step) for (let y = minY; y <= maxY; y += step) grid.push([x, y]);

  const chosen: Pt[] = [];
  for (const t of targets) {
    const sorted = grid
      .map((p) => ({ p, d: Math.hypot(p[0] - t[0], p[1] - t[1]) }))
      .sort((a, b) => a.d - b.d);
    const hit = sorted.find(({ p }) => valid(p, chosen));
    if (hit) chosen.push(hit.p);
  }
  return chosen;
}

function distToPrimitive(p: Pt, prim: Primitive): number {
  if (prim.kind === 'circle') return Math.hypot(p[0] - prim.center[0], p[1] - prim.center[1]) - prim.r;
  if (prim.kind === 'stroke') {
    if (prim.seg.type === 'line') return distPointSegment(p, prim.from, prim.seg.end) - prim.width / 2;
    const pts = contourPoints({ start: prim.from, segs: [prim.seg] });
    let d = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distPointSegment(p, pts[i], pts[i + 1]));
    return d - prim.width / 2;
  }
  const poly = contourPoints(prim.outer);
  return pointInPolygon(p, poly) ? 0 : distToPolyline(p, poly);
}
