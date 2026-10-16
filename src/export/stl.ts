// Binary STL writer (all meshes merged into one file).
import type { TriMesh } from './mesh';

export function writeStl(meshes: TriMesh[], header = 'pcb-maker'): Uint8Array {
  const triCount = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const head = new TextEncoder().encode(header.slice(0, 80));
  new Uint8Array(buf, 0, head.length).set(head);
  view.setUint32(80, triCount, true);
  let off = 84;
  for (const m of meshes) {
    const v = m.vertices;
    const t = m.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3;
      const b = t[i + 1] * 3;
      const c = t[i + 2] * 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      view.setFloat32(off, nx, true);
      view.setFloat32(off + 4, ny, true);
      view.setFloat32(off + 8, nz, true);
      off += 12;
      for (const idx of [a, b, c]) {
        view.setFloat32(off, v[idx], true);
        view.setFloat32(off + 4, v[idx + 1], true);
        view.setFloat32(off + 8, v[idx + 2], true);
        off += 12;
      }
      view.setUint16(off, 0, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}
