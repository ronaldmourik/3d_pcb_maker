// Regression test on ketel_opto with a KiCad 10 ground pour (filled zone) on the bottom.
// It caught: Drawing.offset crashing on the pour (every grown/shrunk copper stage), solids made invalid by
// pour vertices lying just off the line between their neighbours, and dowels never fitting in pour holes.
import { beforeAll, describe, expect, it } from 'vitest';
import { measureArea, cast } from 'replicad';
import { fixtureLayers, initOC } from './helpers';
import { toBoardInput } from '../src/gerber/loadFiles';
import { layerFace } from '../src/geometry/faces';
import { buildModel } from '../src/geometry/brep';
import { isValid } from '../src/geometry/occ';
import { defaultSettings } from '../src/state/settings';

beforeAll(initOC);

const FILES = ['B_Cu.gbr', 'F_Cu.gbr', 'Edge_Cuts.gbr', 'NPTH.drl', 'PTH.drl'].map((f) => `ketel_opto_solid/ketel_opto-${f}`);
const input = () => toBoardInput(fixtureLayers(FILES));
/* eslint-disable @typescript-eslint/no-explicit-any */
const area = (f: any) => measureArea(cast(f) as any);

describe('ketel_opto with a filled zone', () => {
  it('grows and shrinks the pour into valid faces', () => {
    const prims = input().bottom!;
    expect(prims.some((p) => p.kind === 'contour' && (p.holes?.length ?? 0) > 5)).toBe(true);
    const base = area(layerFace(prims, 0, { failed: 0 }));
    let prev = 0;
    for (const offset of [-0.25, -0.05, 0.2, 0.8]) {
      const st = { failed: 0 };
      const f = layerFace(prims, offset, st);
      expect(st.failed).toBe(0);
      expect(isValid(f)).toBe(true);
      const a = area(f);
      expect(a).toBeGreaterThan(prev);
      expect(a > base).toBe(offset > 0);
      prev = a;
    }
  });

  it('builds valid raised halves with the pour drilled through', () => {
    const r = buildModel(input(), { ...defaultSettings, sides: 'both', mode: 'raised' });
    expect(r.warnings.filter((w) => !w.includes('Dowel socket depth'))).toEqual([]);
    for (const p of r.parts) for (const b of p.bodies) expect(isValid(b.shape.wrapped), `${p.id} ${b.name}`).toBe(true);
  });

  it('places dowels in the clearance holes of the pour', () => {
    const r = buildModel(input(), { ...defaultSettings, sides: 'both', mode: 'recessed', dowelDiameter: 1, dowelEdgeMargin: 0.3 });
    expect(r.dowelPositions).toHaveLength(4);
    for (const p of r.parts) for (const b of p.bodies) expect(isValid(b.shape.wrapped), `${p.id} ${b.name}`).toBe(true);
  });
});
