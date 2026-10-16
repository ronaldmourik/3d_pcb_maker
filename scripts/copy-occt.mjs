// Copies occt-import-js (used by the STEP preview viewer) into public/occt, together with the LGPL
// license texts of both OpenCascade WebAssembly builds that the site ships.
import { cpSync, mkdirSync } from 'node:fs';
const src = new URL('../node_modules/occt-import-js/dist/', import.meta.url);
const dst = new URL('../public/occt/', import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of ['occt-import-js.js', 'occt-import-js.wasm', 'occt-import-js-worker.js', 'license.occt.txt', 'license.occt-import-js.txt']) {
  cpSync(new URL(f, src), new URL(f, dst));
}
cpSync(new URL('../node_modules/replicad-opencascadejs/LICENSE', import.meta.url), new URL('license.replicad-opencascadejs.txt', dst));
