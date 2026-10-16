// Copies occt-import-js (used by the STEP preview viewer) into public/occt.
import { cpSync, mkdirSync } from 'node:fs';
const src = new URL('../node_modules/occt-import-js/dist/', import.meta.url);
const dst = new URL('../public/occt/', import.meta.url);
mkdirSync(dst, { recursive: true });
for (const f of ['occt-import-js.js', 'occt-import-js.wasm', 'occt-import-js-worker.js']) {
  cpSync(new URL(f, src), new URL(f, dst));
}
