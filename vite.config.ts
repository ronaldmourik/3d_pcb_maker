import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const OCCT_CDN = "'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/'";

// online-3d-viewer hardcodes a CDN location for occt-import-js. Point it at the copy in public/occt
// (see scripts/copy-occt.mjs), resolved against the page URL so it also works under a sub-path
// (GitHub Pages) and offline.
function localOcctImport(): Plugin {
  return {
    name: 'local-occt-import',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('o3dv.module.js')) return null;
      if (!code.includes(OCCT_CDN)) this.error('online-3d-viewer changed its occt-import-js location; update vite.config.ts');
      return code.replace(OCCT_CDN, "new URL('occt/', self.location.href).href");
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), localOcctImport()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['replicad-opencascadejs', 'online-3d-viewer'] },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000, hookTimeout: 120000 },
});
