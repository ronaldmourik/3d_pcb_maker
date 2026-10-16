// Turns a BuildResult into files: preview STEP (laid out), and per-part STEP / STL / 3MF.
import { exportSTEP, makeCylinder, type AnyShape } from 'replicad';
import { zipSync } from 'fflate';
import type { BuildResult, Part, PartId } from './brep';
import { COLORS } from './brep';
import { tessellate } from '../export/mesh';
import { writeStl } from '../export/stl';
import { write3mf } from '../export/threemf';
import { writeSvg } from '../export/svg';
import { writeDxf } from '../export/dxf';
import { mapPattern } from '../export/paths2d';

export type ExportFormat = 'step' | 'stl' | '3mf' | 'svg' | 'dxf';
export type ExportTarget = PartId | 'all' | 'copperTop' | 'copperBottom';

export const isCutFormat = (f: ExportFormat) => f === 'svg' || f === 'dxf';
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
    out.push(...issueMarkers(r, opt));
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
  out.push(...issueMarkers(r, opt));
  return out;
}

export interface IssueSpot {
  message: string;
  level?: 'info';
  /** Position in preview (STEP) coordinates, on the copper face. */
  at: [number, number, number];
}

/** Where each located issue appears in the preview for the given layout. */
export function previewIssueSpots(r: BuildResult, opt: PreviewOptions): IssueSpot[] {
  const { minX, maxX } = r.bounds;
  const W = maxX - minX;
  const cx = (minX + maxX) / 2;
  const topZ = (id: PartId) => {
    const p = r.parts.find((x) => x.id === id);
    return p ? Math.max(...p.bodies.map((b) => zRange(b.shape)[1])) : 0;
  };
  return r.issues.map((i) => {
    const [x, y] = i.at;
    const base = { message: i.message, level: i.level };
    if (!r.doubleSided) {
      // Single-sided boards are printed copper-up; a bottom layer is mirrored.
      return { ...base, at: [i.side === 'bottom' ? 2 * cx - x : x, y, topZ('board')] };
    }
    if (i.side === 'top') return { ...base, at: [x, y, topZ('topHalf')] };
    if (opt.layout === 'assembled') return { ...base, at: [x, y, -topZ('bottomHalf')] };
    return { ...base, at: [2 * cx - x + W + GAP, y, topZ('bottomHalf')] };
  });
}

/** Red pins marking located issues (preview only, never exported). */
function issueMarkers(r: BuildResult, opt: PreviewOptions): ShapeConfig[] {
  return previewIssueSpots(r, opt)
    .filter((i) => i.level !== 'info')
    .map((i) => {
    const up = i.at[2] >= 0 ? 1 : -1;
    const base: [number, number, number] = [i.at[0], i.at[1], up > 0 ? i.at[2] : i.at[2] - 1.5];
    return { shape: makeCylinder(0.25, 1.5, base), name: `Issue: ${i.message}`, color: COLORS.issue };
  });
}

export function previewStep(r: BuildResult, opt: PreviewOptions): Blob {
  return exportSTEP(previewShapes(r, opt), { unit: 'MM' });
}

function partFile(r: BuildResult, p: Part, format: ExportFormat, tol: number, angTol: number): { name: string; data: Uint8Array | Blob } {
  const base = `${r.name}-${p.id}`;
  if (format === 'step') return { name: `${base}.step`, data: exportSTEP(p.bodies.map((b) => ({ shape: b.shape, name: b.name, color: b.color })), { unit: 'MM' }) };
  const meshes = p.bodies.map((b) => ({ ...tessellate(b.shape, b.name, b.color, tol, angTol), material: b.material }));
  if (format === 'stl') return { name: `${base}.stl`, data: writeStl(meshes, base) };
  return { name: `${base}.3mf`, data: write3mf(meshes, base) };
}

function patternFile(r: BuildResult, side: 'top' | 'bottom', format: ExportFormat, mirror: boolean): { name: string; data: Uint8Array } {
  let p = r.cutPatterns[side];
  if (!p) throw new Error(`No ${side} copper pattern available`);
  if (mirror) {
    const cx = (r.bounds.minX + r.bounds.maxX) / 2;
    p = mapPattern(p, (q) => [2 * cx - q[0], q[1]]);
  }
  const base = `${r.name}-copper-${side}${mirror ? '-mirrored' : ''}`;
  const text = format === 'svg' ? writeSvg(p, base) : writeDxf(p);
  return { name: `${base}.${format}`, data: new TextEncoder().encode(text) };
}

export async function exportParts(
  r: BuildResult,
  partId: ExportTarget,
  format: ExportFormat,
  tol: number,
  angTol: number,
  opts: { mirror?: boolean } = {},
): Promise<{ name: string; data: Uint8Array }> {
  const toBytes = async (d: Uint8Array | Blob) => (d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : d);
  if (isCutFormat(format)) {
    const sides: ('top' | 'bottom')[] =
      partId === 'copperTop' ? ['top'] : partId === 'copperBottom' ? ['bottom'] : (Object.keys(r.cutPatterns) as ('top' | 'bottom')[]);
    const files = sides.map((side) => patternFile(r, side, format, !!opts.mirror));
    if (files.length === 1) return files[0];
    return { name: `${r.name}-copper-${format}.zip`, data: zipSync(Object.fromEntries(files.map((f) => [f.name, f.data]))) };
  }
  if (partId === 'copperTop' || partId === 'copperBottom') throw new Error('Copper patterns export as SVG or DXF');
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
