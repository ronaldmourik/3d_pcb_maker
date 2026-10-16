import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { parseLayerFile, toBoardInput } from '../src/gerber/loadFiles';

let ready: Promise<void> | null = null;

export function initOC(): Promise<void> {
  if (!ready) {
    const wasm = fileURLToPath(new URL('../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
    ready = (opencascade as any)({ locateFile: () => wasm }).then((oc: any) => setOC(oc));
  }
  return ready!;
}

export const FIXTURES = ['demo-F_Cu.gbr', 'demo-B_Cu.gbr', 'demo-Edge_Cuts.gbr', 'demo-PTH.drl'];

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'latin1');
}

export function fixtureLayers(names = FIXTURES) {
  // Like a real upload: the layer gets the bare file name, not the fixture sub-path.
  return names.map((n) => parseLayerFile(n.split('/').pop()!, fixture(n)));
}

export function fixtureInput(names = FIXTURES) {
  return toBoardInput(fixtureLayers(names));
}
