// Regression test on ketel_opto with a KiCad 10 ground pour (filled zone) on the bottom.
// It caught: Drawing.offset crashing on the pour (every grown/shrunk copper stage), solids made invalid by
// pour vertices lying just off the line between their neighbours, and dowels never fitting in pour holes.
import { beforeAll, describe, expect, it } from 'vitest';
import { cast, makeBox, measureArea, measureVolume } from 'replicad';
import type { Primitive, Pt } from '../src/gerber/types';
import { faceLoops } from '../src/geometry/paths';
import { loopPolygon, splitZones } from '../src/geometry/zones';
import { fixtureLayers, initOC } from './helpers';
import { toBoardInput } from '../src/gerber/loadFiles';
import { layerFace } from '../src/geometry/faces';
import { buildModel, faceList } from '../src/geometry/brep';
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

describe('ketel_opto: filled zone left as leftover copper', () => {
  const anchor = (p: Primitive): Pt => (p.kind === 'circle' ? p.center : p.kind === 'stroke' ? p.from : p.outer.start);
  /** Board material in a 0.2 × 0.2 × 0.1 mm probe just under the top surface at (x, y). */
  const material = (shape: any, x: number, y: number, top: number) =>
    measureVolume(shape.clone().intersect(makeBox([x - 0.1, y - 0.1, top - 0.1], [x + 0.1, y + 0.1, top])));

  it('drops the zone and exactly the copper connected to it', () => {
    const prims = input().bottom!;
    const merged = layerFace(prims, 0, { failed: 0 });
    const islands = faceList(merged).map((f) => faceLoops(f).map(loopPolygon));
    const { kept, zoneIslands, connected } = splitZones(prims, islands);
    expect(zoneIslands).toHaveLength(1);
    const dropped = prims.filter((p) => !kept.includes(p) && !(p.kind === 'contour' && p.zone)).map(anchor);
    // The KETEL_0V copper on B.Cu: J1/J3 pin 2, D1 A, U1 K, K1 NO and the short trace at U1.
    const expected: Pt[] = [[109.08, -105], [109.08, -173], [110, -139.81], [115.19, -139.77], [116.3, -160.4], [115.15, -139.81]];
    expect(connected).toBe(expected.length);
    for (const e of expected) expect(dropped.some((d) => Math.hypot(d[0] - e[0], d[1] - e[1]) < 1e-6), String(e)).toBe(true);
  });

  it('grooves the zone outline but not the zone (groove and raised)', () => {
    for (const mode of ['groove', 'raised'] as const) {
      const r = buildModel(input(), { ...defaultSettings, sides: 'bottom', mode, skipZones: true, stampEnabled: true });
      expect(r.issues.some((i) => i.level === 'info' && i.message.includes('1 filled zone(s) and 6 connected'))).toBe(true);
      for (const p of r.parts) for (const b of p.bodies) expect(isValid(b.shape.wrapped), `${mode} ${p.id} ${b.name}`).toBe(true);
      // Bottom boards are mirrored about the board centre x = 130: the zone edge at x = 159 lands at x = 101.
      const board = r.parts[0].bodies[0].shape;
      const T = defaultSettings.boardThickness;
      expect(material(board, 260 - 159.4, -140, T), `${mode} separator`).toBeLessThan(1e-6);
      expect(material(board, 260 - 125, -165, T), `${mode} zone`).toBeGreaterThan(0.0039);
      if (mode === 'raised') expect(measureVolume(r.parts[0].bodies[1].shape)).toBeLessThan(250); // traces only, no pour
    }
  });

  it('fits the dowels once the zone is not grooved', () => {
    const r = buildModel(input(), { ...defaultSettings, sides: 'both', mode: 'groove', skipZones: true });
    expect(r.dowelPositions).toHaveLength(4);
  });
});
