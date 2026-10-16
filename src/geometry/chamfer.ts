// 45° chamfers: on the top rim of recessed channels, and on the top edges of raised copper.
//
// OpenCascade's edge chamfer fails on typical PCB geometry (traces exactly as wide as their pads give
// tangent contacts). Instead we cut a tapered tool: the chamfer volume of a union is the union of the
// chamfer volumes of its parts (Minkowski sum distributes over union), so every primitive gets its own
// lofted frustum whose top and bottom outlines share the same topology.
import { cast, draw, getOC, type Drawing } from 'replicad';
import type { Contour, Primitive, Pt, Seg } from '../gerber/types';
import { arcSweep } from '../gerber/gerber';
import { contourPoints, polygonArea } from '../gerber/geom2d';
import { arcBand, circleDrawing, contourDrawing, primitiveDrawings, primitivePoint, stadium, type Progress } from './faces';
import { drawingFace, prism } from './occ';
import { arcAngles, type PathSeg } from '../export/paths2d';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TopoShape = any;

const EPS = 1e-4;
/** Corner rounding at the bottom of the chamfer on sharp polygon corners (keeps loft topology stable). */
const RHO = 1e-3;
/** How far the tool sticks out above the board surface. */
const OVER = 0.2;

export interface ChamferStats {
  lofted: number;
  stepped: number;
  failed: number;
  failedAt?: Pt[];
}

/**
 * Tools that, cut from a board whose channels have their top at `top`, chamfer the channel rims by `size`.
 * `offset` is the copper grow/shrink applied to the channels.
 */
export function chamferTools(prims: Primitive[], offset: number, top: number, size: number, stats: ChamferStats, progress?: Progress): TopoShape[] {
  const z0 = top - size;
  const grow = size + OVER; // offset at the tool's top, z0 + grow
  const tools: TopoShape[] = [];
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (progress && (i % 25 === 0 || i === prims.length - 1)) progress(i + 1, prims.length);
    if (!p.dark) continue; // clear areas are rare in copper; their rims are left unchamfered
    try {
      const pairs = sectionPairs(p, offset, grow);
      if (pairs) {
        for (const [a, b] of pairs) tools.push(loft(a, b, z0, z0 + grow));
        stats.lofted++;
      } else {
        tools.push(...stepped(p, offset, z0, size));
        stats.stepped++;
      }
    } catch {
      stats.failed++;
      (stats.failedAt ??= []).push(primitivePoint(p));
    }
  }
  return tools;
}

/** Bottom/top outline pairs for one primitive, or null if it needs the stepped fallback. */
function sectionPairs(p: Primitive, offset: number, grow: number): [Drawing, Drawing][] | null {
  switch (p.kind) {
    case 'circle': {
      const r = p.r + offset;
      return r > EPS ? [[circleDrawing(p.center, r), circleDrawing(p.center, r + grow)]] : [];
    }
    case 'stroke': {
      const h = p.width / 2 + offset;
      if (h <= EPS) return [];
      if (p.seg.type === 'line') return [[stadium(p.from, p.seg.end, h), stadium(p.from, p.seg.end, h + grow)]];
      const { center, cw } = p.seg;
      const r = Math.hypot(p.from[0] - center[0], p.from[1] - center[1]);
      if (r - h - grow <= EPS) return null;
      const sweep = arcSweep(p.from, p.seg.end, center, cw);
      const a0 = Math.atan2(p.from[1] - center[1], p.from[0] - center[0]);
      const dir = cw ? -1 : 1;
      const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
      const out: [Drawing, Drawing][] = [];
      for (let k = 0; k < n; k++) {
        const s0 = a0 + (dir * sweep * k) / n;
        const s1 = a0 + (dir * sweep * (k + 1)) / n;
        out.push([arcBand(center, r, s0, s1, h), arcBand(center, r, s0, s1, h + grow)]);
      }
      return out;
    }
    case 'contour': {
      if (p.holes?.length) return null;
      const base = roundedOffset(p.outer, offset, RHO);
      const topC = roundedOffset(p.outer, offset + grow, RHO);
      if (!base || !topC) return null;
      return [[contourDrawing(base), contourDrawing(topC)]];
    }
  }
}

/**
 * Exact 45° chamfer tools for the top rim of a solid whose top face is the region bounded by `loops`
 * (lines/arcs from `faceLoops`). A point at height z is removed when it lies within (z − z0) of the boundary.
 * Distance to a union of edges is the minimum over the edges, so the removal region is the union of:
 * a 45° wedge along every straight edge, a revolved wedge along every arc, and a cone at every vertex.
 * All surfaces are planes and cones, which keeps the booleans fast.
 * Cut the returned tools from the solid (they only remove material that is inside it).
 */
export function edgeChamferTools(loops: PathSeg[][], top: number, size: number, progress?: Progress): TopoShape[] {
  const z0 = top - size;
  const grow = size + OVER;
  const tools: TopoShape[] = [];
  const vertices: Pt[] = [];
  const addVertex = (q: Pt) => {
    if (!vertices.some((v) => Math.hypot(v[0] - q[0], v[1] - q[1]) < 1e-6)) vertices.push(q);
  };
  const segs = loops.flat();
  segs.forEach((sg, i) => {
    if (progress && (i % 25 === 0 || i === segs.length - 1)) progress(i + 1, segs.length);
    addVertex(sg.a);
    addVertex(sg.b);
    const g = sg.type === 'arc' ? arcAngles(sg.a, sg.m, sg.b) : null;
    if (g) tools.push(arcWedge(g.c, g.r, g.start, g.sweep, z0, grow));
    else if (Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) > EPS) tools.push(lineWedge(sg.a, sg.b, z0, grow));
  });
  for (const v of vertices) tools.push(revolveProfile([[0, -FLAT], [FLAT, -FLAT], [grow + FLAT, grow], [0, grow]], v, 0, 2 * Math.PI, z0));
  return tools;
}

/**
 * Tents get a tiny flat bottom just below the slope start, so their faces cross the solid's side walls
 * instead of touching them along an edge (coincident edges make the boolean fail). Error: FLAT mm.
 */
const FLAT = 1e-4;

/** Closed polygon (u, v) on the XZ plane: u → X, v → Z. */
function profileFace(points: [number, number][]): TopoShape {
  let pen = draw(points[0]);
  for (const q of points.slice(1)) pen = pen.lineTo(q);
  return (pen.close().sketchOnPlane('XZ') as any).face().wrapped;
}

/** Inverted triangle (apex on the edge at z0) swept along the edge a → b. */
function lineWedge(a: Pt, b: Pt, z0: number, grow: number): TopoShape {
  const OC = getOC() as any;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const face = profileFace([[-FLAT, -FLAT], [FLAT, -FLAT], [grow + FLAT, grow], [-grow - FLAT, grow]]);
  const v = new OC.gp_Vec(0, L, 0);
  const mk = new OC.BRepPrimAPI_MakePrism(face, v, false, true);
  try {
    const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI - 90;
    return cast(mk.Shape()).rotate(angle, [0, 0, 0], [0, 0, 1]).translate(a[0], a[1], z0).wrapped;
  } finally {
    mk.delete();
    v.delete();
  }
}

/** The same triangle revolved around the arc centre over the arc's sweep. */
function arcWedge(c: Pt, r: number, start: number, sweep: number, z0: number, grow: number): TopoShape {
  // Inside the arc the triangle may cross the axis; clip it there (still exact: those points are within reach).
  const profile: [number, number][] =
    r - grow - 2 * FLAT > EPS
      ? [[r - FLAT, -FLAT], [r + FLAT, -FLAT], [r + grow + FLAT, grow], [r - grow - FLAT, grow]]
      : [[r - FLAT, -FLAT], [r + FLAT, -FLAT], [r + grow + FLAT, grow], [0, grow], [0, r - 2 * FLAT]];
  const from = sweep >= 0 ? start : start + sweep;
  return revolveProfile(profile, c, from, Math.abs(sweep), z0);
}

function revolveProfile(profile: [number, number][], at: Pt, fromAngle: number, sweep: number, z0: number): TopoShape {
  const OC = getOC() as any;
  const face = profileFace(profile);
  const origin = new OC.gp_Pnt(0, 0, 0);
  const dir = new OC.gp_Dir(new OC.gp_Vec(0, 0, 1));
  const axis = new OC.gp_Ax1(origin, dir);
  const mk = new OC.BRepPrimAPI_MakeRevol(face, axis, Math.min(sweep, 2 * Math.PI), false);
  try {
    let shape = cast(mk.Shape());
    if (fromAngle) shape = shape.rotate((fromAngle * 180) / Math.PI, [0, 0, 0], [0, 0, 1]);
    return shape.translate(at[0], at[1], z0).wrapped;
  } finally {
    mk.delete();
    axis.delete();
    dir.delete();
    origin.delete();
  }
}

function wireOf(d: Drawing, z: number): TopoShape {
  return (d.sketchOnPlane('XY', z) as any).wire.wrapped;
}

function loft(bottom: Drawing, topD: Drawing, z0: number, z1: number): TopoShape {
  const OC = getOC() as any;
  const ts = new OC.BRepOffsetAPI_ThruSections(true, true, 1e-6);
  try {
    ts.AddWire(OC.TopoDS.Wire(wireOf(bottom, z0)));
    ts.AddWire(OC.TopoDS.Wire(wireOf(topD, z1)));
    ts.CheckCompatibility(false);
    ts.Build();
    if (!ts.IsDone()) throw new Error('loft failed');
    return ts.Shape();
  } finally {
    ts.delete();
  }
}

/** Fallback: three stacked prisms approximating the slope. */
function stepped(p: Primitive, offset: number, z0: number, size: number): TopoShape[] {
  const n = 3;
  const out: TopoShape[] = [];
  for (let k = 0; k < n; k++) {
    const grow = (size * (k + 0.5)) / n;
    const zb = z0 + (size * k) / n;
    for (const d of primitiveDrawings(p, offset + grow)) out.push(prism(drawingFace(d), zb, size - (size * k) / n + OVER).wrapped);
  }
  return out;
}

/**
 * Offset of a convex contour (lines + convex arcs) by `d`, with sharp corners rounded at radius `rho + d`
 * around the corner inset by `rho`. Returns null for contours that are not convex.
 * For d = 0 the result follows the original edges except for a `rho` rounding at sharp corners, and the
 * topology is the same for every d, which is what the loft needs.
 */
export function roundedOffset(c: Contour, d: number, rho: number): Contour | null {
  // Normalise to counter-clockwise.
  let contour = c;
  if (polygonArea(contourPoints(c)) < 0) contour = reverseContour(c);
  interface El {
    seg: Seg;
    from: Pt;
  }
  const els: El[] = [];
  let cur = contour.start;
  for (const s of contour.segs) {
    if (Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]) < EPS) continue;
    if (s.type === 'arc' && s.cw) return null; // concave arc on a CCW outline
    els.push({ seg: s, from: cur });
    cur = s.end;
  }
  const n = els.length;
  if (n < 2) return null;
  const tangentStart = (e: El): Pt => {
    if (e.seg.type === 'line') return unit([e.seg.end[0] - e.from[0], e.seg.end[1] - e.from[1]]);
    const r: Pt = [e.from[0] - e.seg.center[0], e.from[1] - e.seg.center[1]];
    return unit([-r[1], r[0]]);
  };
  const tangentEnd = (e: El): Pt => {
    if (e.seg.type === 'line') return tangentStart(e);
    const r: Pt = [e.seg.end[0] - e.seg.center[0], e.seg.end[1] - e.seg.center[1]];
    return unit([-r[1], r[0]]);
  };
  const outward = (t: Pt): Pt => [t[1], -t[0]];
  // Corner after element i (between i and i+1).
  const corners = els.map((e, i) => {
    const t1 = tangentEnd(e);
    const t2 = tangentStart(els[(i + 1) % n]);
    const cross = t1[0] * t2[1] - t1[1] * t2[0];
    const dot = t1[0] * t2[0] + t1[1] * t2[1];
    return { v: e.seg.end, t1, t2, sharp: !(Math.abs(cross) < 1e-6 && dot > 0), convex: cross > -1e-9 };
  });
  if (corners.some((k) => k.sharp && !k.convex)) return null;
  // Sharp corners must be between two lines (the inset formula below assumes straight neighbours).
  for (let i = 0; i < n; i++) {
    if (!corners[i].sharp) continue;
    if (els[i].seg.type !== 'line' || els[(i + 1) % n].seg.type !== 'line') return null;
  }
  const insetVertex = (k: (typeof corners)[number]): Pt => {
    const n1 = outward(k.t1);
    const n2 = outward(k.t2);
    const f = rho / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [k.v[0] - f * (n1[0] + n2[0]), k.v[1] - f * (n1[1] + n2[1])];
  };
  // Start/end point of each element after offsetting.
  const startOf = (i: number): Pt => {
    const k = corners[(i - 1 + n) % n];
    const e = els[i];
    const nrm = outward(tangentStart(e));
    if (k.sharp) {
      const iv = insetVertex(k);
      return [iv[0] + (rho + d) * nrm[0], iv[1] + (rho + d) * nrm[1]];
    }
    return [e.from[0] + d * nrm[0], e.from[1] + d * nrm[1]];
  };
  const endOf = (i: number): Pt => {
    const k = corners[i];
    const e = els[i];
    const nrm = outward(tangentEnd(e));
    if (k.sharp) {
      const iv = insetVertex(k);
      return [iv[0] + (rho + d) * nrm[0], iv[1] + (rho + d) * nrm[1]];
    }
    return [e.seg.end[0] + d * nrm[0], e.seg.end[1] + d * nrm[1]];
  };
  const segs: Seg[] = [];
  const start = startOf(0);
  for (let i = 0; i < n; i++) {
    const e = els[i];
    const end = endOf(i);
    if (e.seg.type === 'line') segs.push({ type: 'line', end });
    else segs.push({ type: 'arc', end, center: e.seg.center, cw: false });
    const k = corners[i];
    const next = startOf((i + 1) % n);
    if (k.sharp) segs.push({ type: 'arc', end: next, center: insetVertex(k), cw: false });
  }
  // The last segment must close exactly on the start point.
  const last = segs[segs.length - 1];
  segs[segs.length - 1] = { ...last, end: start };
  return { start, segs };
}

function unit(v: Pt): Pt {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

function reverseContour(c: Contour): Contour {
  const pts: Pt[] = [c.start, ...c.segs.map((s) => s.end)];
  const segs: Seg[] = [];
  for (let i = c.segs.length - 1; i >= 0; i--) {
    const s = c.segs[i];
    const end = pts[i];
    segs.push(s.type === 'line' ? { type: 'line', end } : { type: 'arc', end, center: s.center, cw: !s.cw });
  }
  return { start: pts[pts.length - 1], segs };
}
