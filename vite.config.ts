import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// online-3d-viewer hardcodes a CDN location for occt-import-js. Point it at the
// copy in public/occt (see scripts/copy-occt.mjs) so the app works offline.
function localOcctImport(): Plugin {
  return {
    name: 'local-occt-import',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('o3dv.module.js')) return null;
      return code.replace(
        "'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/'",
        "(self.location.origin + import.meta.env.BASE_URL + 'occt/')",
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), localOcctImport()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['replicad-opencascadejs', 'online-3d-viewer'] },
  test: { testTimeout: 120000, hookTimeout: 120000 },
});
