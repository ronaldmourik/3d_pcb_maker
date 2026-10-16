// "Fractured" regions: EDA tools (KiCad zone fills) export a polygon with holes as one outline that runs
// into each hole along a zero-width slit and back out the same way. Planar face builders choke on that,
// so the slits are removed and the remaining edges are re-chained into an outer boundary plus holes.
import type { Contour, Pt, Seg } from './types';
import { contourPoints, pointInPolygon, polygonArea } from './geom2d';

const KEY = (p: Pt) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;

interface Edge {
  from: Pt;
  seg: Seg;
}

export interface RegionShape {
  outer: Contour;
  holes: Contour[];
}

/** Split a contour with slits into separate regions with holes; null when it has no slits. */
export function splitFracturedContour(c: Contour): RegionShape[] | null {
  const edges: Edge[] = [];
  let cur = c.start;
  for (const seg of c.segs) {
    if (KEY(cur) !== KEY(seg.end)) edges.push({ from: cur, seg });
    cur = seg.end;
  }
  // A slit is a straight segment that is also traversed in the opposite direction.
  const lineKey = (a: Pt, b: Pt) => `${KEY(a)}>${KEY(b)}`;
  const count = new Map<string, number>();
  for (const e of edges) if (e.seg.type === 'line') count.set(lineKey(e.from, e.seg.end), (count.get(lineKey(e.from, e.seg.end)) ?? 0) + 1);
  const isSlit = (e: Edge) => e.seg.type === 'line' && (count.get(lineKey(e.seg.end, e.from)) ?? 0) > 0;
  const kept = edges.filter((e) => !isSlit(e));
  if (kept.length === edges.length) return null;

  // Chain the remaining edges head to tail into closed loops.
  const byStart = new Map<string, number[]>();
  kept.forEach((e, i) => byStart.set(KEY(e.from), [...(byStart.get(KEY(e.from)) ?? []), i]));
  const used = new Array(kept.length).fill(false);
  const loops: Contour[] = [];
  for (let i = 0; i < kept.length; i++) {
    if (used[i]) continue;
    const segs: Seg[] = [];
    const start = kept[i].from;
    let j = i;
    while (j >= 0 && !used[j]) {
      used[j] = true;
      segs.push(kept[j].seg);
      const end = kept[j].seg.end;
      if (KEY(end) === KEY(start)) break;
      j = (byStart.get(KEY(end)) ?? []).find((k) => !used[k]) ?? -1;
    }
    if (segs.length >= 2) {
      segs[segs.length - 1] = { ...segs[segs.length - 1], end: start };
      loops.push({ start, segs });
    }
  }

  // Nesting decides outer boundaries and holes (even depth = outer).
  const polys = loops.map((l) => contourPoints(l));
  const areas = polys.map((p) => Math.abs(polygonArea(p)));
  const depth = loops.map((_, i) => polys.filter((p, k) => k !== i && areas[k] > areas[i] && pointInPolygon(polys[i][0], p)).length);
  const out: RegionShape[] = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) out.push({ outer: l, holes: [] });
  });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 1) {
      // Attach to the smallest enclosing outer.
      let best: RegionShape | null = null;
      let bestArea = Infinity;
      loops.forEach((o, k) => {
        if (depth[k] % 2 === 0 && areas[k] > areas[i] && areas[k] < bestArea && pointInPolygon(polys[i][0], polys[k])) {
          best = out.find((r) => r.outer === o) ?? null;
          bestArea = areas[k];
        }
      });
      (best as RegionShape | null)?.holes.push(l);
    }
  });
  return out;
}
