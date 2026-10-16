// Thin helpers over raw OpenCascade operations that replicad does not batch for us.
import { cast, getOC, Sketches, type AnyShape, type Drawing } from 'replicad';

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
