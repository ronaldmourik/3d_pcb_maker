// Builds closed board outlines (outer contours + cutouts) from Edge.Cuts primitives.
import type { Contour, Primitive, Pt, Seg } from './types';
import { contourPoints, pointInPolygon, polygonArea } from './geom2d';

export interface OutlineShape {
  outer: Contour;
  holes: Contour[];
}

export interface OutlineResult {
  shapes: OutlineShape[];
  openSegments: number;
}

interface Piece {
  from: Pt;
  seg: Seg;
}

const TOL = 0.02;
const near = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= TOL;

function reversePiece(p: Piece): Piece {
  const end = p.seg.end;
  if (p.seg.type === 'line') return { from: end, seg: { type: 'line', end: p.from } };
  return { from: end, seg: { type: 'arc', end: p.from, center: p.seg.center, cw: !p.seg.cw } };
}

export function buildOutline(prims: Primitive[]): OutlineResult {
  const loops: Contour[] = [];
  const pieces: Piece[] = [];
  for (const p of prims) {
    if (p.kind === 'contour' && p.dark) loops.push(p.outer);
    else if (p.kind === 'stroke') {
      if (near(p.from, p.seg.end)) {
        if (p.seg.type === 'arc') loops.push({ start: p.from, segs: [p.seg] });
        continue; // zero-length line
      }
      pieces.push({ from: p.from, seg: p.seg });
    }
  }

  const used = new Array(pieces.length).fill(false);
  let openSegments = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const chain: Piece[] = [pieces[i]];
    const start = pieces[i].from;
    let end = pieces[i].seg.end;
    let closed = near(start, end);
    while (!closed) {
      let found = -1;
      let rev = false;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        if (near(pieces[j].from, end)) {
          found = j;
          break;
        }
        if (near(pieces[j].seg.end, end)) {
          found = j;
          rev = true;
          break;
        }
      }
      if (found < 0) break;
      used[found] = true;
      const piece = rev ? reversePiece(pieces[found]) : pieces[found];
      chain.push(piece);
      end = piece.seg.end;
      closed = near(start, end);
    }
    if (!closed) {
      openSegments += chain.length;
      continue;
    }
    // Snap endpoints so the contour closes exactly.
    const segs: Seg[] = chain.map((c, k) => {
      const e = k === chain.length - 1 ? start : chain[k + 1].from;
      return c.seg.type === 'line' ? { type: 'line', end: e } : { ...c.seg, end: e };
    });
    loops.push({ start, segs });
  }

  // Nesting: even depth = outer boundary, odd depth = cutout of its direct parent.
  const polys = loops.map((l) => contourPoints(l));
  const areas = polys.map((p) => Math.abs(polygonArea(p)));
  const parent: number[] = loops.map(() => -1);
  const depth: number[] = loops.map(() => 0);
  for (let i = 0; i < loops.length; i++) {
    let best = -1;
    for (let j = 0; j < loops.length; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      if (pointInPolygon(polys[i][0], polys[j])) {
        depth[i]++;
        if (best < 0 || areas[j] < areas[best]) best = j;
      }
    }
    parent[i] = best;
  }
  const shapes: OutlineShape[] = [];
  const index = new Map<number, OutlineShape>();
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) {
      const s = { outer: l, holes: [] as Contour[] };
      index.set(i, s);
      shapes.push(s);
    }
  });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 1 && parent[i] >= 0) index.get(parent[i])?.holes.push(l);
  });
  return { shapes, openSegments };
}
