// Regression test on the double-sided KiCad 10 export of ketel_opto.
// It caught faces with mixed orientation (clockwise trace outlines vs counter-clockwise pads):
// the 2D fuse then left pads overlapping traces and turned one pad into a hole.
import { beforeAll, describe, expect, it } from 'vitest';
import { cast, getOC, measureVolume } from 'replicad';
import { fixtureLayers, initOC } from './helpers';
import { toBoardInput } from '../src/gerber/loadFiles';
import { layerFace } from '../src/geometry/faces';
import { buildModel, disposeBuild } from '../src/geometry/brep';
import { GeometryCache } from '../src/geometry/cache';
import { isValid } from '../src/geometry/occ';
import { defaultSettings } from '../src/state/settings';

beforeAll(initOC);

const FILES = ['B_Cu.gbr', 'F_Cu.gbr', 'Edge_Cuts.gbr', 'NPTH.drl', 'PTH.drl'].map((f) => `ketel_opto_double/ketel_opto-${f}`);
const input = () => toBoardInput(fixtureLayers(FILES));

/* eslint-disable @typescript-eslint/no-explicit-any */
function faces(shape: any) {
  const OC = getOC() as any;
  const out: { normalZ: number; wires: number }[] = [];
  const exp = new OC.TopExp_Explorer(shape, OC.TopAbs_ShapeEnum.TopAbs_FACE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; exp.More(); exp.Next()) {
    let wires = 0;
    const w = new OC.TopExp_Explorer(exp.Current(), OC.TopAbs_ShapeEnum.TopAbs_WIRE, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; w.More(); w.Next()) wires++;
    w.delete();
    out.push({ normalZ: (cast(exp.Current()) as any).normalAt().z, wires });
  }
  exp.delete();
  return out;
}

describe('ketel_opto double-sided', () => {
  it('merges every connected net into one upward face without false holes', () => {
    const b = input();
    // Top: 42 pads, one trace joins the two vias. Bottom: traces join pads into 23 regions.
    for (const [prims, expected] of [
      [b.top!, 41],
      [b.bottom!, 23],
    ] as const) {
      const f = faces(layerFace(prims, 0, { failed: 0 }));
      expect(f).toHaveLength(expected);
      expect(f.every((x) => x.normalZ > 0.99)).toBe(true);
      // No copper on this board encloses a loop, so any inner wire is a fuse artefact.
      expect(f.every((x) => x.wires === 1)).toBe(true);
    }
  });

  it('builds valid raised halves', () => {
    const r = buildModel(input(), { ...defaultSettings, sides: 'both', mode: 'raised', stampEnabled: true });
    expect(r.parts.map((p) => p.id)).toEqual(['topHalf', 'bottomHalf', 'dowels', 'stampTop', 'stampBottom']);
    for (const p of r.parts) for (const b of p.bodies) expect(isValid(b.shape.wrapped)).toBe(true);
    const copper = r.parts.find((p) => p.id === 'bottomHalf')!.bodies[1].shape;
    // Each merged copper region is one closed solid.
    expect(faces(copper.wrapped).every((x) => x.wires >= 1)).toBe(true);
    const OC = getOC() as any;
    let solids = 0;
    const exp = new OC.TopExp_Explorer(copper.wrapped, OC.TopAbs_ShapeEnum.TopAbs_SOLID, OC.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) solids++;
    exp.delete();
    expect(solids).toBe(23);
    expect(measureVolume(copper)).toBeGreaterThan(300);
  });

  it('reuses cached stages and gives identical results', () => {
    const cache = new GeometryCache();
    const base = { ...defaultSettings, sides: 'both' as const, mode: 'recessed' as const, channelChamfer: 0.2 };
    const t0 = Date.now();
    const first = buildModel(input(), base, undefined, cache);
    const tFirst = Date.now() - t0;
    expect(first.cacheHits).toBe(0);

    // Only a stamp setting changes: outline, copper, holes and both halves come from the cache.
    const t1 = Date.now();
    const second = buildModel(input(), { ...base, stampEnabled: true }, undefined, cache);
    const tSecond = Date.now() - t1;
    expect(second.cacheHits).toBeGreaterThanOrEqual(4);
    for (const id of ['topHalf', 'bottomHalf']) {
      const v = (r: typeof first) => measureVolume(r.parts.find((p) => p.id === id)!.bodies[0].shape);
      expect(v(second)).toBeCloseTo(v(first), 6);
    }
    expect(second.warnings).toEqual(first.warnings);
    // The chamfered halves dominate the first build; the second only builds the stamps.
    expect(tSecond).toBeLessThan(tFirst);

    // Disposing a build must not break the cache (results are clones).
    disposeBuild(first);
    const third = buildModel(input(), base, undefined, cache);
    expect(isValid(third.parts[0].bodies[0].shape.wrapped)).toBe(true);

    // A different input clears the cache.
    const other = buildModel(toBoardInput(fixtureLayers(['ketel_opto/ketel_opto-B_Cu.gbr', 'ketel_opto/ketel_opto-Edge_Cuts.gbr'])), { ...base, sides: 'bottom' }, undefined, cache);
    expect(other.cacheHits).toBe(0);
  });

  it('chamfers recessed channels on both halves', () => {
    const base = { ...defaultSettings, sides: 'both' as const, mode: 'recessed' as const };
    const sharp = buildModel(input(), base);
    const chamfered = buildModel(input(), { ...base, channelChamfer: 0.2 });
    expect(chamfered.warnings.filter((w) => w.includes('hamfer'))).toEqual([]);
    for (const id of ['topHalf', 'bottomHalf']) {
      const a = sharp.parts.find((p) => p.id === id)!.bodies[0].shape;
      const b = chamfered.parts.find((p) => p.id === id)!.bodies[0].shape;
      expect(isValid(b.wrapped)).toBe(true);
      expect(measureVolume(b)).toBeLessThan(measureVolume(a));
    }
  });
});
