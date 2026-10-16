// Turns a BuildResult into files: preview STEP (laid out), and per-part STEP / STL / 3MF.
import { exportSTEP, makeCylinder, type AnyShape } from 'replicad';
import { zipSync } from 'fflate';
import type { BuildResult, Part, PartId } from './brep';
import { COLORS } from './brep';
import { tessellate } from '../export/mesh';
import { writeStl } from '../export/stl';
import { write3mf } from '../export/threemf';

export type ExportFormat = 'step' | 'stl' | '3mf';
export type PreviewLayout = 'print' | 'assembled';

export interface PreviewOptions {
  layout: PreviewLayout;
  showStamps: boolean;
}

interface ShapeConfig {
  shape: AnyShape;
  name: string;
  color: string;
}

const GAP = 8;

function zRange(shape: AnyShape): [number, number] {
  const [min, max] = shape.boundingBox.bounds;
  return [min[2], max[2]];
}

/** Rotate 180° about the Y-parallel axis through x = cx (turn a part over). */
function flip(shape: AnyShape, cx: number): AnyShape {
  return shape.mirror('YZ', [cx, 0, 0]).mirror('XY', [0, 0, 0]);
}

export function previewShapes(r: BuildResult, opt: PreviewOptions): ShapeConfig[] {
  const { minX, minY, maxX, maxY } = r.bounds;
  const W = maxX - minX;
  const H = maxY - minY;
  const cx = (minX + maxX) / 2;
  const part = (id: PartId) => r.parts.find((p) => p.id === id);
  const out: ShapeConfig[] = [];
  const add = (p: Part | undefined, f: (s: AnyShape) => AnyShape) => {
    // replicad transforms consume their input, so always work on a clone.
    if (p) for (const b of p.bodies) out.push({ shape: f(b.shape.clone()), name: b.name, color: b.color });
  };
  const stampTop = opt.showStamps ? part('stampTop') : undefined;
  const stampBottom = opt.showStamps ? part('stampBottom') : undefined;

  if (opt.layout === 'print') {
    add(part('board'), (s) => s);
    add(part('topHalf'), (s) => s);
    add(part('bottomHalf'), (s) => s.translate(W + GAP, 0, 0));
    add(part('dowels'), (s) => (r.doubleSided ? s.translate(W + GAP, 0, 0) : s));
    const singleBottom = !r.doubleSided && !!stampBottom;
    add(stampTop, (s) => s.translate(0, -(H + GAP), 0));
    add(stampBottom, (s) => s.translate(singleBottom ? 0 : W + GAP, -(H + GAP), 0));
    return out;
  }

  // Assembled: stacked as used, with exploded gaps.
  let top = 0;
  let bottom = 0;
  const track = (s: AnyShape) => {
    const [z0, z1] = zRange(s);
    top = Math.max(top, z1);
    bottom = Math.min(bottom, z0);
    return s;
  };
  if (!r.doubleSided) {
    add(part('board'), track);
  } else {
    add(part('topHalf'), track);
    add(part('bottomHalf'), (s) => track(flip(s, cx)));
    if (r.dowelPositions.length) {
      const rad = r.dowelDiameter / 2;
      for (const p of r.dowelPositions) {
        out.push({ shape: makeCylinder(rad, r.dowelLength, [p[0], p[1], -r.dowelLength / 2]), name: 'Dowel', color: COLORS.dowel });
      }
    }
  }
  const stampAbove = stampTop ?? (!r.doubleSided ? stampBottom : undefined);
  add(stampAbove, (s) => {
    const f = flip(s, cx);
    return f.translateZ(top + GAP - zRange(f)[0]);
  });
  if (r.doubleSided)
    add(stampBottom, (s) => {
      const [, z1] = zRange(s);
      return s.translateZ(bottom - GAP - z1);
    });
  return out;
}

export function previewStep(r: BuildResult, opt: PreviewOptions): Blob {
  return exportSTEP(previewShapes(r, opt), { unit: 'MM' });
}

function partFile(r: BuildResult, p: Part, format: ExportFormat, tol: number, angTol: number): { name: string; data: Uint8Array | Blob } {
  const base = `${r.name}-${p.id}`;
  if (format === 'step') return { name: `${base}.step`, data: exportSTEP(p.bodies.map((b) => ({ shape: b.shape, name: b.name, color: b.color })), { unit: 'MM' }) };
  const meshes = p.bodies.map((b) => tessellate(b.shape, b.name, b.color, tol, angTol));
  if (format === 'stl') return { name: `${base}.stl`, data: writeStl(meshes, base) };
  return { name: `${base}.3mf`, data: write3mf(meshes, base) };
}

export async function exportParts(
  r: BuildResult,
  partId: PartId | 'all',
  format: ExportFormat,
  tol: number,
  angTol: number,
): Promise<{ name: string; data: Uint8Array }> {
  const toBytes = async (d: Uint8Array | Blob) => (d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : d);
  if (partId !== 'all') {
    const p = r.parts.find((x) => x.id === partId);
    if (!p) throw new Error(`Part ${partId} not available`);
    const f = partFile(r, p, format, tol, angTol);
    return { name: f.name, data: await toBytes(f.data) };
  }
  const files: Record<string, Uint8Array> = {};
  for (const p of r.parts) {
    const f = partFile(r, p, format, tol, angTol);
    files[f.name] = await toBytes(f.data);
  }
  return { name: `${r.name}-${format}.zip`, data: zipSync(files) };
}
