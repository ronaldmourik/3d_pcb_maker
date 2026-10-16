// Tessellation of B-rep bodies for STL / 3MF export.
import type { AnyShape } from 'replicad';

export interface TriMesh {
  name: string;
  color: string;
  vertices: Float32Array;
  /** Material name (3MF base material); defaults to the colour. */
  material?: string;
  triangles: Uint32Array;
}

export function tessellate(shape: AnyShape, name: string, color: string, tolerance: number, angularTolerance: number): TriMesh {
  const m = (shape as any).mesh({ tolerance, angularTolerance }) as { vertices: number[]; triangles: number[] };
  return { name, color, vertices: Float32Array.from(m.vertices), triangles: Uint32Array.from(m.triangles) };
}
