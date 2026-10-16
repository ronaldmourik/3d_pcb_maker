// Extracts plain 2D outlines (lines + arcs, board coordinates) from planar OpenCascade faces for cutter exports.
import { cast, getOC } from 'replicad';
import type { PathSeg, P2 } from '../export/paths2d';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TopoShape = any;

const TOL = 1e-6;
const same = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < TOL;

function explore(shape: TopoShape, kind: 'TopAbs_FACE' | 'TopAbs_WIRE' | 'TopAbs_EDGE', fn: (s: TopoShape) => void) {
  const OC = getOC() as any;
  const exp = new OC.TopExp_Explorer(shape, OC.TopAbs_ShapeEnum[kind], OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) fn(exp.Current());
  exp.delete();
}

/**
 * All boundary loops (outer + holes) of every face in `shape`, as ordered segments, oriented so the face
 * lies to the left of the direction of travel (outer boundaries counter-clockwise, holes clockwise).
 */
export function faceLoops(shape: TopoShape | null): PathSeg[][] {
  if (!shape) return [];
  const OC = getOC() as any;
  const loops: PathSeg[][] = [];
  explore(shape, 'TopAbs_FACE', (face) => {
    const own: PathSeg[][] = [];
    explore(face, 'TopAbs_WIRE', (wire) => {
      const segs: PathSeg[] = [];
      explore(wire, 'TopAbs_EDGE', (edge) => segs.push(...edgeSegs(cast(OC.TopoDS.Edge(edge)))));
      own.push(chain(segs));
    });
    const areas = own.map(loopArea);
    const outer = areas.reduce((best, a, i) => (Math.abs(a) > Math.abs(areas[best]) ? i : best), 0);
    own.forEach((l, i) => loops.push((i === outer) === areas[i] > 0 ? l : reverseLoop(l)));
  });
  return loops;
}

/** Signed area (positive = counter-clockwise), arcs approximated through their mid points. */
export function loopArea(loop: PathSeg[]): number {
  const pts: P2[] = [];
  for (const s of loop) {
    pts.push(s.a);
    if (s.type === 'arc') pts.push(s.m);
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length];
    a += pts[i][0] * q[1] - q[0] * pts[i][1];
  }
  return a / 2;
}

function reverseLoop(loop: PathSeg[]): PathSeg[] {
  return loop.map(reverse).reverse();
}

function edgeSegs(e: any): PathSeg[] {
  const p = (v: any): P2 => [v.x, v.y];
  const a = p(e.startPoint);
  const b = p(e.endPoint);
  if (e.geomType === 'LINE') return [{ type: 'line', a, b }];
  if (e.geomType === 'CIRCLE') {
    if (!same(a, b)) return [{ type: 'arc', a, m: p(e.pointAt(0.5)), b }];
    // Full circle: two half arcs.
    const h = p(e.pointAt(0.5));
    return [
      { type: 'arc', a, m: p(e.pointAt(0.25)), b: h },
      { type: 'arc', a: h, m: p(e.pointAt(0.75)), b },
    ];
  }
  // Anything else (splines, ellipses): a fine polyline.
  const out: PathSeg[] = [];
  const N = 32;
  let prev = a;
  for (let i = 1; i <= N; i++) {
    const q = i === N ? b : p(e.pointAt(i / N));
    out.push({ type: 'line', a: prev, b: q });
    prev = q;
  }
  return out;
}

const reverse = (s: PathSeg): PathSeg => (s.type === 'line' ? { type: 'line', a: s.b, b: s.a } : { type: 'arc', a: s.b, m: s.m, b: s.a });

/** Order the segments of one wire head-to-tail. */
function chain(segs: PathSeg[]): PathSeg[] {
  if (segs.length < 2) return segs;
  const rest = segs.slice(1);
  const out = [segs[0]];
  while (rest.length) {
    const end = out[out.length - 1].b;
    let i = rest.findIndex((s) => same(s.a, end));
    if (i >= 0) {
      out.push(rest.splice(i, 1)[0]);
      continue;
    }
    i = rest.findIndex((s) => same(s.b, end));
    if (i >= 0) {
      out.push(reverse(rest.splice(i, 1)[0]));
      continue;
    }
    // Disconnected piece (should not happen for a valid wire): keep it, the writers start a new subpath.
    out.push(rest.shift()!);
  }
  return out;
}
