// Printability check ("DRC for 3D printing"): features the nozzle or the copper tape can't handle.
import { cast, getOC } from 'replicad';
import type { Drill, Primitive, Pt } from '../gerber/types';
import { arcSweep } from '../gerber/gerber';

/* eslint-disable @typescript-eslint/no-explicit-any */
type TopoShape = any;

export interface PrintIssue {
  message: string;
  at: Pt;
}

export interface PrintCheckOptions {
  nozzle: number;
  minGap: number;
  copperOffset: number;
}

const fmt = (v: number) => v.toFixed(2);

/** Traces (strokes) narrower than `2 × nozzle`. */
export function narrowTraces(prims: Primitive[], o: PrintCheckOptions): PrintIssue[] {
  const minFeature = 2 * o.nozzle;
  const out: PrintIssue[] = [];
  for (const p of prims) {
    if (!p.dark || p.kind !== 'stroke') continue;
    const w = p.width + 2 * o.copperOffset;
    if (w < minFeature - 1e-9) out.push({ message: `Trace ${fmt(w)} mm wide (min ${fmt(minFeature)})`, at: strokeMid(p) });
  }
  return out;
}

/**
 * Copper regions that disappear completely when every shape is shrunk by `nozzle` are narrower than
 * `2 × nozzle` everywhere (small pads). Works on whole pads, so multi-primitive macro pads are fine.
 */
export function vanishedRegions(copper: TopoShape, eroded: TopoShape | null, nozzle: number, alreadyReported: Pt[] = []): PrintIssue[] {
  const boxes = (shape: TopoShape | null) => faceBoxes(shape).map((f) => f.b);
  const survivors = boxes(eroded);
  const out: PrintIssue[] = [];
  for (const { b } of faceBoxes(copper)) {
    const inside = survivors.some((e) => e[0] >= b[0] - 1e-6 && e[1] >= b[1] - 1e-6 && e[2] <= b[2] + 1e-6 && e[3] <= b[3] + 1e-6);
    const reported = alreadyReported.some((p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]);
    if (!inside && !reported) {
      const w = Math.min(b[2] - b[0], b[3] - b[1]);
      out.push({ message: `Copper feature ${fmt(w)} mm across (min ${fmt(2 * nozzle)})`, at: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] });
    }
  }
  return out;
}

function faceBoxes(shape: TopoShape | null): { f: TopoShape; b: [number, number, number, number] }[] {
  if (!shape) return [];
  const OC = getOC() as any;
  const out: { f: TopoShape; b: [number, number, number, number] }[] = [];
  const exp = new OC.TopExp_Explorer(shape, OC.TopAbs_ShapeEnum.TopAbs_FACE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) {
    const f = OC.TopoDS.Face(exp.Current());
    const [min, max] = cast(f).boundingBox.bounds;
    out.push({ f, b: [min[0], min[1], max[0], max[1]] });
  }
  exp.delete();
  return out;
}

/** Gaps between separate copper regions narrower than `minGap` (exact, from the merged B-rep faces). */
export function narrowGaps(copper: TopoShape, minGap: number): PrintIssue[] {
  const OC = getOC() as any;
  const faces = faceBoxes(copper);
  const out: PrintIssue[] = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i].b;
      const c = faces[j].b;
      const dx = Math.max(0, a[0] - c[2], c[0] - a[2]);
      const dy = Math.max(0, a[1] - c[3], c[1] - a[3]);
      if (Math.hypot(dx, dy) >= minGap) continue;
      const ext = new OC.BRepExtrema_DistShapeShape(faces[i].f, faces[j].f);
      try {
        if (!ext.IsDone()) continue;
        const d = ext.Value();
        if (d >= minGap - 1e-9) continue;
        const p1 = ext.PointOnShape1(1);
        const p2 = ext.PointOnShape2(1);
        out.push({ message: `Gap ${fmt(d)} mm between copper (min ${fmt(minGap)})`, at: [(p1.X() + p2.X()) / 2, (p1.Y() + p2.Y()) / 2] });
        p1.delete();
        p2.delete();
      } finally {
        ext.delete();
      }
    }
  }
  return out;
}

export function smallHoles(drills: Drill[], holeOffset: number, minHoleDiameter: number, nozzle: number): PrintIssue[] {
  const min = 2 * nozzle;
  return drills
    .filter((d) => d.diameter >= minHoleDiameter && d.diameter + holeOffset < min - 1e-9)
    .map((d) => ({ message: `Hole ${fmt(d.diameter + holeOffset)} mm (min ${fmt(min)} for the nozzle)`, at: d.at }));
}

function strokeMid(p: Extract<Primitive, { kind: 'stroke' }>): Pt {
  if (p.seg.type === 'line') return [(p.from[0] + p.seg.end[0]) / 2, (p.from[1] + p.seg.end[1]) / 2];
  const { center, cw } = p.seg;
  const r = Math.hypot(p.from[0] - center[0], p.from[1] - center[1]);
  const a0 = Math.atan2(p.from[1] - center[1], p.from[0] - center[0]);
  const a = a0 + ((cw ? -1 : 1) * arcSweep(p.from, p.seg.end, center, cw)) / 2;
  return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
}
