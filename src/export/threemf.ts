// 3MF writer: one mesh object per body, grouped as parts of a single build object.
import { strToU8, zipSync } from 'fflate';
import type { TriMesh } from './mesh';

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Weld identical vertices so slicers see a connected (manifold) mesh. */
function weld(m: TriMesh): { verts: number[]; tris: number[] } {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const remap = new Uint32Array(m.vertices.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const x = m.vertices[i * 3], y = m.vertices[i * 3 + 1], z = m.vertices[i * 3 + 2];
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length / 3;
      map.set(key, idx);
      verts.push(x, y, z);
    }
    remap[i] = idx;
  }
  const tris: number[] = [];
  for (let i = 0; i < m.triangles.length; i += 3) {
    const a = remap[m.triangles[i]], b = remap[m.triangles[i + 1]], c = remap[m.triangles[i + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { verts, tris };
}

export function write3mf(meshes: TriMesh[], title: string): Uint8Array {
  const colors = [...new Set(meshes.map((m) => m.color))];
  const parts: string[] = [];
  meshes.forEach((m, i) => {
    const { verts, tris } = weld(m);
    const v: string[] = [];
    for (let k = 0; k < verts.length; k += 3) v.push(`<vertex x="${+verts[k].toFixed(5)}" y="${+verts[k + 1].toFixed(5)}" z="${+verts[k + 2].toFixed(5)}"/>`);
    const t: string[] = [];
    for (let k = 0; k < tris.length; k += 3) t.push(`<triangle v1="${tris[k]}" v2="${tris[k + 1]}" v3="${tris[k + 2]}"/>`);
    parts.push(
      `<object id="${i + 2}" name="${esc(m.name)}" type="model" pid="1" pindex="${colors.indexOf(m.color)}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`,
    );
  });
  const groupId = meshes.length + 2;
  const components = meshes.map((_, i) => `<component objectid="${i + 2}"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(title)}</metadata>
<metadata name="Application">pcb-maker</metadata>
<resources>
<basematerials id="1">${colors.map((c, i) => `<base name="color${i}" displaycolor="${c.toUpperCase()}FF"/>`).join('')}</basematerials>
${parts.join('\n')}
<object id="${groupId}" name="${esc(title)}" type="model"><components>${components}</components></object>
</resources>
<build><item objectid="${groupId}"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
}
