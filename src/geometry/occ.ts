// Thin helpers over raw OpenCascade operations that replicad does not batch for us.
import { cast, getOC, measureArea, Sketches, type AnyShape, type Drawing } from 'replicad';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TopoShape = any;

const oc = () => getOC() as any;

function list(shapes: TopoShape[]) {
  const l = new (oc().NCollection_List_TopoDS_Shape)();
  for (const s of shapes) l.Append(s);
  return l;
}

function runBoolean(kind: 'Fuse' | 'Cut' | 'Common', args: TopoShape[], tools: TopoShape[]): TopoShape {
  const OC = oc();
  const a = list(args);
  const t = list(tools);
  const op = new OC[`BRepAlgoAPI_${kind}`]();
  try {
    op.SetArguments(a);
    op.SetTools(t);
    op.SetRunParallel(false);
    op.Build();
    if (op.HasErrors() || !op.IsDone()) throw new Error(`OpenCascade ${kind.toLowerCase()} failed`);
    op.SimplifyResult(true, true, 1e-3);
    return op.Shape();
  } finally {
    op.delete();
    a.delete();
    t.delete();
  }
}

/** Union of many shapes in a single multi-argument boolean. */
export function fuseAll(shapes: TopoShape[]): TopoShape | null {
  if (!shapes.length) return null;
  if (shapes.length === 1) return shapes[0];
  return runBoolean('Fuse', [shapes[0]], shapes.slice(1));
}

export function cutAll(shape: TopoShape, tools: TopoShape[]): TopoShape {
  if (!tools.length) return shape;
  return runBoolean('Cut', [shape], tools);
}

export function common(a: TopoShape, b: TopoShape): TopoShape {
  return runBoolean('Common', [a], [b]);
}

/** Merge coplanar faces / collinear edges left behind by booleans. */
export function unify(shape: TopoShape): TopoShape {
  const OC = oc();
  const u = new OC.ShapeUpgrade_UnifySameDomain(shape, true, true, false);
  try {
    u.AllowInternalEdges(false);
    u.Build();
    return u.Shape();
  } finally {
    u.delete();
  }
}

/**
 * 2D offset of planar face(s) at z=0 with round joins (negative shrinks); null when nothing is left.
 * Native and fast, unlike replicad's Drawing.offset, which gives up on large regions such as pours.
 */
export function offsetFace(shape: TopoShape, d: number): TopoShape | null {
  const OC = oc();
  // The offset returns bare wires; rebuild the region by nesting depth (even: solid, odd: hole).
  const loops: { face: TopoShape; segs: number[][]; at: [number, number]; area: number }[] = [];
  const faces = new OC.TopExp_Explorer(shape, OC.TopAbs_ShapeEnum.TopAbs_FACE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; faces.More(); faces.Next()) {
    const mk = new OC.BRepOffsetAPI_MakeOffset(OC.TopoDS.Face(faces.Current()), OC.GeomAbs_JoinType.GeomAbs_Arc, false);
    try {
      mk.Perform(d, 0);
      if (!mk.IsDone()) throw new Error('OpenCascade offset failed');
      const wires = new OC.TopExp_Explorer(mk.Shape(), OC.TopAbs_ShapeEnum.TopAbs_WIRE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; wires.More(); wires.Next()) {
        const wire = OC.TopoDS.Wire(wires.Current());
        const mf = new OC.BRepBuilderAPI_MakeFace(wire, true);
        const face = facesUp(mf.Face());
        mf.delete();
        // Each edge sampled on its own: ray crossing counts do not need the edges in order.
        const segs: number[][] = [];
        const edges = new OC.TopExp_Explorer(wire, OC.TopAbs_ShapeEnum.TopAbs_EDGE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; edges.More(); edges.Next()) {
          const e = cast(edges.Current()) as any;
          const n = e.geomType === 'LINE' ? 1 : 16;
          let prev = e.pointAt(0);
          for (let k = 1; k <= n; k++) {
            const p = e.pointAt(k / n);
            segs.push([prev.x, prev.y, p.x, p.y]);
            prev = p;
          }
        }
        edges.delete();
        if (segs.length) loops.push({ face, segs, at: [segs[0][0], segs[0][1]], area: measureArea(cast(face) as any) });
      }
      wires.delete();
    } finally {
      mk.delete();
    }
  }
  faces.delete();
  if (!loops.length) return null;

  const inside = ([x, y]: [number, number], segs: number[][]) => {
    let odd = false;
    for (const [x0, y0, x1, y1] of segs) if (y0 > y !== y1 > y && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) odd = !odd;
    return odd;
  };
  const byDepth: TopoShape[][] = [];
  for (const l of loops) {
    const depth = loops.filter((o) => o !== l && o.area > l.area && inside(l.at, o.segs)).length;
    (byDepth[depth] ??= []).push(l.face);
  }
  let acc: TopoShape | null = null;
  byDepth.forEach((fs, depth) => {
    if (depth % 2 === 0) acc = fuseAll(acc ? [acc, ...fs] : fs);
    else if (acc) acc = cutAll(acc, [fuseAll(fs)]);
  });
  return acc && !isNullOrEmpty(acc) ? acc : null;
}

export function isNullOrEmpty(shape: TopoShape | null): boolean {
  if (!shape || shape.IsNull()) return true;
  const OC = oc();
  const exp = new OC.TopExp_Explorer(shape, OC.TopAbs_ShapeEnum.TopAbs_FACE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const has = exp.More();
  exp.delete();
  return !has;
}

/** Extrude planar face(s) lying at z=0 to a solid occupying [z0, z0 + h]. */
export function prism(face: TopoShape, z0: number, h: number): AnyShape {
  const OC = oc();
  const v = new OC.gp_Vec(0, 0, h);
  const mk = new OC.BRepPrimAPI_MakePrism(face, v, true, true);
  try {
    const shape = cast(mk.Shape());
    return z0 ? shape.translateZ(z0) : shape;
  } finally {
    mk.delete();
    v.delete();
  }
}

/** Face(s) of a closed drawing on the XY plane, always with a +Z normal. */
export function drawingFace(d: Drawing): TopoShape {
  const sk = d.sketchOnPlane('XY');
  if (sk instanceof Sketches) return facesUp(sk.faces().wrapped);
  return facesUp((sk as any).face().wrapped);
}

/**
 * Clockwise contours give faces with a -Z normal. Booleans between planar faces of
 * opposite orientation go wrong (overlaps survive or turn into holes), so flip them up.
 */
export function facesUp(shape: TopoShape): TopoShape {
  const OC = oc();
  const faces: TopoShape[] = [];
  let flipped = false;
  const exp = new OC.TopExp_Explorer(shape, OC.TopAbs_ShapeEnum.TopAbs_FACE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) {
    const face = OC.TopoDS.Face(exp.Current());
    if ((cast(face) as any).normalAt().z < 0) {
      faces.push(face.Reversed());
      flipped = true;
    } else faces.push(face);
  }
  exp.delete();
  if (!flipped) return shape;
  if (faces.length === 1) return faces[0];
  const compound = new OC.TopoDS_Compound();
  const builder = new OC.BRep_Builder();
  builder.MakeCompound(compound);
  for (const f of faces) builder.Add(compound, f);
  builder.delete();
  return compound;
}

export function isValid(shape: TopoShape): boolean {
  const OC = oc();
  const an = new OC.BRepCheck_Analyzer(shape, true, false);
  const ok = an.IsValid();
  an.delete();
  return ok;
}
