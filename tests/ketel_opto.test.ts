// Regression test on a real KiCad 10 export: single-sided (bottom copper) through-hole board.
import { beforeAll, describe, expect, it } from 'vitest';
import { measureVolume } from 'replicad';
import { fixtureLayers, initOC } from './helpers';
import { toBoardInput } from '../src/gerber/loadFiles';
import { buildModel, type BuildResult } from '../src/geometry/brep';
import { exportParts } from '../src/geometry/output';
import { isValid } from '../src/geometry/occ';
import { defaultSettings, type Settings } from '../src/state/settings';

beforeAll(initOC);

const FILES = ['B_Cu.gbr', 'Edge_Cuts.gbr', 'job.gbrjob', 'NPTH.drl', 'PTH.drl'].map((f) => `ketel_opto/ketel_opto-${f}`);
const layers = () => fixtureLayers(FILES);
const build = (over: Partial<Settings>) => buildModel(toBoardInput(layers()), { ...defaultSettings, sides: 'bottom', ...over });
const vol = (r: BuildResult, part: string, body = 0) => measureVolume(r.parts.find((p) => p.id === part)!.bodies[body].shape);

describe('ketel_opto (KiCad 10, bottom copper)', () => {
  it('detects layers', () => {
    const summary = layers().map((l) => [l.fileName, l.role, l.primitives.length, l.drills.length]);
    expect(summary).toEqual([
      ['ketel_opto-B_Cu.gbr', 'bottom-copper', 76, 0],
      ['ketel_opto-Edge_Cuts.gbr', 'outline', 4, 0],
      ['ketel_opto-job.gbrjob', 'ignore', 0, 0],
      ['ketel_opto-NPTH.drl', 'drill', 0, 3],
      ['ketel_opto-PTH.drl', 'drill', 0, 42],
    ]);
    for (const l of layers()) if (l.kind !== 'unknown') expect(l.warnings).toEqual([]);
    expect(toBoardInput(layers()).name).toBe('ketel_opto');
  });

  it('builds a valid recessed board with rib stamp', () => {
    const r = build({ mode: 'recessed', stampEnabled: true });
    expect(r.warnings).toEqual([]);
    expect(r.doubleSided).toBe(false);
    expect(r.bounds).toEqual({ minX: 100, minY: -176, maxX: 162, maxY: -96 });
    expect(r.parts.map((p) => p.id)).toEqual(['board', 'stampBottom']);
    for (const p of r.parts) for (const b of p.bodies) expect(isValid(b.shape.wrapped)).toBe(true);
    expect(vol(r, 'board')).toBeCloseTo(7416.6, 0);
    expect(vol(r, 'stampBottom')).toBeCloseTo(10293.0, 0);
  });

  it('builds a valid raised board whose copper matches the recessed channels', () => {
    const raised = build({ mode: 'raised', stampEnabled: true, cuttingRidge: true });
    const recessed = build({ mode: 'recessed' });
    expect(raised.warnings).toEqual([]);
    for (const p of raised.parts) for (const b of p.bodies) expect(isValid(b.shape.wrapped)).toBe(true);
    expect(vol(raised, 'board', 0)).toBeCloseTo(7829.7, 0);
    expect(vol(raised, 'board', 1)).toBeCloseTo(413.1, 0);
    expect(vol(raised, 'board', 0) - vol(recessed, 'board', 0)).toBeCloseTo(vol(raised, 'board', 1), 2);
    expect(vol(raised, 'stampBottom')).toBeCloseTo(9575.7, 0);
  });

  it('exports STEP, STL and 3MF', async () => {
    const r = build({ mode: 'recessed' });
    for (const format of ['step', 'stl', '3mf'] as const) {
      const f = await exportParts(r, 'board', format, 0.01, 0.1);
      expect(f.name).toBe(`ketel_opto-board.${format}`);
      expect(f.data.length).toBeGreaterThan(10000);
    }
  });
});
