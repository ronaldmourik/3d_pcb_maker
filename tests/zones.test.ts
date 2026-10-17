// Filled zones left as leftover copper, on a generated board with two neighbouring zones (one X2-tagged, one
// not): neither zone is processed, a separator groove runs between them, and the other trace still is.
import { beforeAll, describe, expect, it } from 'vitest';
import { makeBox, measureVolume } from 'replicad';
import { initOC } from './helpers';
import { twoZonesGerber } from './pourFixture';
import { parseLayerFile, toBoardInput } from '../src/gerber/loadFiles';
import { buildModel } from '../src/geometry/brep';
import { isValid } from '../src/geometry/occ';
import { defaultSettings, type Settings } from '../src/state/settings';

beforeAll(initOC);

/* eslint-disable @typescript-eslint/no-explicit-any */
const input = () => toBoardInput([parseLayerFile('zones-F_Cu.gbr', twoZonesGerber())]);
const base: Settings = { ...defaultSettings, sides: 'top', outlineSource: 'bounding-box', margin: 3, skipZones: true, stampEnabled: true };
const T = base.boardThickness;
/** Board material in a 0.2 × 0.2 × 0.1 mm probe just under the top surface at (x, y). */
const material = (shape: any, x: number, y: number) => measureVolume(shape.clone().intersect(makeBox([x - 0.1, y - 0.1, T - 0.1], [x + 0.1, y + 0.1, T])));
const FULL = 0.0039;

describe('two filled zones left as leftover copper', () => {
  for (const mode of ['groove', 'raised'] as const)
    it(`separates them with a groove (${mode})`, () => {
      const r = buildModel(input(), { ...base, mode });
      expect(r.issues.some((i) => i.message.startsWith('2 filled zone(s) and 2 connected'))).toBe(true);
      for (const p of r.parts) for (const b of p.bodies) expect(isValid(b.shape.wrapped), `${p.id} ${b.name}`).toBe(true);
      const board = r.parts[0].bodies[0].shape;
      expect(material(board, 20, 10), 'gap between the zones').toBeLessThan(1e-6);
      expect(material(board, 20, 19), 'gap near the zone corner').toBeLessThan(1e-6);
      expect(material(board, 5, 15), 'inside the left zone').toBeGreaterThan(FULL);
      expect(material(board, 35, 5), 'inside the right zone').toBeGreaterThan(FULL);
      // The zone pads are not processed: no groove around them.
      expect(material(board, 11.4, 10), 'next to the left pad').toBeGreaterThan(FULL);
      expect(material(board, 31.4, 10), 'next to the right pad').toBeGreaterThan(FULL);
      if (mode === 'groove') {
        // The trace of the other net keeps its groove.
        expect(material(board, 20, -3.1), 'beside the trace').toBeLessThan(1e-6);
        expect(r.parts.some((p) => p.id === 'stampTop')).toBe(true);
        expect(r.warnings.filter((w) => w.includes('ridge'))).toEqual([]);
      } else {
        // Raised: only the trace stands proud, the zones are flat board.
        const copper = r.parts[0].bodies[1].shape;
        expect(measureVolume(copper)).toBeCloseTo(36 * 1 * base.traceHeight + Math.PI * 0.25 * base.traceHeight, 0);
      }
    });

  it('processes the zones normally when the toggle is off', () => {
    const r = buildModel(input(), { ...base, mode: 'raised', skipZones: false });
    expect(r.issues.some((i) => i.message.includes('filled zone'))).toBe(false);
    expect(measureVolume(r.parts[0].bodies[1].shape)).toBeGreaterThan(700 * base.traceHeight);
  });

  it('ignores the toggle in recessed mode', () => {
    const on = buildModel(input(), { ...base, mode: 'recessed' });
    const off = buildModel(input(), { ...base, mode: 'recessed', skipZones: false });
    expect(measureVolume(on.parts[0].bodies[0].shape)).toBeCloseTo(measureVolume(off.parts[0].bodies[0].shape), 6);
  });
});
