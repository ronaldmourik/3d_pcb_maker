import { beforeAll, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { measureArea, measureVolume } from 'replicad';
import { fixtureInput, initOC } from './helpers';
import { parseLayerFile, toBoardInput } from '../src/gerber/loadFiles';
import { buildModel, type BuildResult } from '../src/geometry/brep';
import { exportParts, previewStep } from '../src/geometry/output';
import { isValid } from '../src/geometry/occ';
import { defaultSettings, type Settings } from '../src/state/settings';

beforeAll(initOC);

const build = (over: Partial<Settings>) => buildModel(fixtureInput(), { ...defaultSettings, ...over });
const vol = (r: BuildResult, part: string, body = 0) => measureVolume(r.parts.find((p) => p.id === part)!.bodies[body].shape);
const BOARD_AREA = 1200 - 9 + (Math.PI * 9) / 4;
// Copper footprint without drill holes (stamps are not drilled).
const copperArea = () => vol(build({ sides: 'top', mode: 'raised', holes: false }), 'board', 1) / 0.4;

describe('board', () => {
  it('builds a valid raised single-sided board', () => {
    const r = build({ mode: 'raised', sides: 'top' });
    expect(r.parts.map((p) => p.id)).toEqual(['board']);
    for (const b of r.parts[0].bodies) expect(isValid(b.shape.wrapped)).toBe(true);
    expect(r.parts[0].bodies.map((b) => b.name)).toEqual(['Board base', 'Board copper']);
  });

  it('recessed channels remove exactly the raised copper volume', () => {
    const raised = build({ mode: 'raised', sides: 'top' });
    const recessed = build({ mode: 'recessed', sides: 'top' });
    const copper = vol(raised, 'board', 1);
    expect(copper).toBeGreaterThan(10);
    expect(vol(raised, 'board', 0) - vol(recessed, 'board', 0)).toBeCloseTo(copper, 3);
    expect(isValid(recessed.parts[0].bodies[0].shape.wrapped)).toBe(true);
  });

  it('cuts every drill hole', () => {
    const noHoles = build({ sides: 'top', mode: 'raised', holes: false });
    const holes = build({ sides: 'top', mode: 'raised' });
    expect(vol(noHoles, 'board', 0)).toBeCloseTo(BOARD_AREA * 1.6, 1);
    const r = (d: number) => (d + 0.1) / 2;
    const holeArea = 4 * Math.PI * r(1) ** 2 + Math.PI * r(3) ** 2 + (3 * 1.3 + Math.PI * r(1.2) ** 2);
    expect(vol(noHoles, 'board', 0) - vol(holes, 'board', 0)).toBeCloseTo(holeArea * 1.6, 2);
  });

  it('splits double-sided boards into mirrored halves with dowels', () => {
    const r = build({ sides: 'both', mode: 'raised' });
    expect(r.parts.map((p) => p.id)).toEqual(['topHalf', 'bottomHalf', 'dowels']);
    const top = r.parts[0].bodies[0].shape.boundingBox.bounds;
    const bottom = r.parts[1].bodies[0].shape.boundingBox.bounds;
    expect(top[1][2] - top[0][2]).toBeCloseTo(0.8, 5);
    expect(bottom[1][2] - bottom[0][2]).toBeCloseTo(0.8, 5);
    // Mirrored about the board centre, so the x-extent stays the same.
    expect(bottom[0][0]).toBeCloseTo(top[0][0], 5);
    expect(r.dowelPositions).toHaveLength(4);
    // Holes and sockets are identical in both halves (raised copper is a separate body).
    expect(vol(r, 'topHalf', 0)).toBeCloseTo(vol(r, 'bottomHalf', 0), 5);
  });

  it('stamp ribs match the copper footprint shrunk by the clearance', () => {
    const s = { sides: 'top' as const, mode: 'recessed' as const, stampEnabled: true, alignmentPins: false };
    const r0 = build({ ...s, stampClearance: 0 });
    const r1 = build({ ...s, stampClearance: 0.1 });
    const ribH = 0.4 - 0.06;
    expect(vol(r0, 'stampTop') - BOARD_AREA * 2).toBeCloseTo(copperArea() * ribH, 1);
    expect(vol(r1, 'stampTop')).toBeLessThan(vol(r0, 'stampTop'));
  });

  it('pocket stamp for raised boards cuts the copper footprint', () => {
    const r = build({ sides: 'top', mode: 'raised', stampEnabled: true, alignmentPins: false, stampClearance: 0, tapeThickness: 0 });
    expect(BOARD_AREA * 2 - vol(r, 'stampTop')).toBeCloseTo(copperArea() * 0.4, 1);
  });

  it('adds alignment pins on large holes', () => {
    const base = { sides: 'top' as const, mode: 'recessed' as const, stampEnabled: true };
    const withPins = build({ ...base, alignmentPins: true });
    const without = build({ ...base, alignmentPins: false });
    const r = (3 + 0.1 - 0.15) / 2;
    expect(vol(withPins, 'stampTop') - vol(without, 'stampTop')).toBeGreaterThan(Math.PI * r * r * 1.5);
  });
});

describe('variants', () => {
  it('builds a bottom-only board mirrored copper-side up', () => {
    const input = fixtureInput(['demo-B_Cu.gbr', 'demo-Edge_Cuts.gbr', 'demo-PTH.drl']);
    const r = buildModel(input, { ...defaultSettings, sides: 'both', mode: 'raised', stampEnabled: true });
    expect(r.doubleSided).toBe(false);
    expect(r.parts.map((p) => p.id)).toEqual(['board', 'stampBottom']);
    expect(r.warnings.some((w) => w.includes('bottom copper layer'))).toBe(true);
    // The slot at x=138 ends up near x=102 after mirroring about the board centre (x=120).
    const board = r.parts[0].bodies[0].shape;
    expect(isValid(board.wrapped)).toBe(true);
    const [min, max] = board.boundingBox.bounds;
    expect(min[0]).toBeCloseTo(100, 3);
    expect(max[0]).toBeCloseTo(140, 3);
  });

  it('falls back to the copper bounding box without an outline', () => {
    const input = fixtureInput(['demo-F_Cu.gbr', 'demo-PTH.drl']);
    const r = buildModel(input, { ...defaultSettings, sides: 'top', margin: 2 });
    const [min, max] = r.parts[0].bodies[0].shape.boundingBox.bounds;
    // Copper/drills span x 104..138.6 (slot end) -> box 102..140.6
    expect(min[0]).toBeCloseTo(102, 1);
    expect(max[0]).toBeCloseTo(140.6, 1);
    expect(r.warnings.some((w) => w.includes('bounding box'))).toBe(true);
  });

  it('handles a larger generated board in reasonable time', () => {
    const lines = ['%FSLAX46Y46*%', '%MOMM*%', '%ADD10C,1.8*%', '%ADD11C,0.6*%'];
    lines.push('D10*');
    for (let i = 0; i < 20; i++) for (let j = 0; j < 10; j++) lines.push(`X${Math.round((10 + i * 2.54) * 1e6)}Y${Math.round((10 + j * 5.08) * 1e6)}D03*`);
    lines.push('D11*');
    for (let i = 0; i < 19; i++) for (let j = 0; j < 10; j++) {
      lines.push(`X${Math.round((10 + i * 2.54) * 1e6)}Y${Math.round((10 + j * 5.08) * 1e6)}D02*`);
      lines.push(`X${Math.round((10 + (i + 1) * 2.54) * 1e6)}Y${Math.round((10 + j * 5.08 + (i % 2 ? 2.54 : 0)) * 1e6)}D01*`);
    }
    lines.push('M02*');
    const input = toBoardInput([parseLayerFile('big-F_Cu.gbr', lines.join(String.fromCharCode(10)))]);
    const t0 = Date.now();
    const r = buildModel(input, { ...defaultSettings, sides: 'top', mode: 'recessed', stampEnabled: true });
    expect(Date.now() - t0).toBeLessThan(30000);
    expect(isValid(r.parts[0].bodies[0].shape.wrapped)).toBe(true);
  });
});

describe('channel chamfer', () => {
  const single = (gerber: string[]) =>
    toBoardInput([parseLayerFile('t-F_Cu.gbr', ['%FSLAX46Y46*%', '%MOMM*%', ...gerber, 'M02*'].join(String.fromCharCode(10)))]);
  const removed = (input: ReturnType<typeof single>, c: number) => {
    const v = (cc: number) => {
      const r = buildModel(input, { ...defaultSettings, sides: 'top', mode: 'recessed', channelChamfer: cc, holes: false });
      expect(isValid(r.parts[0].bodies[0].shape.wrapped)).toBe(true);
      expect(r.warnings.filter((w) => w.includes('hamfer'))).toEqual([]);
      return measureVolume(r.parts[0].bodies[0].shape);
    };
    return v(0) - v(c);
  };

  it('matches the analytic chamfer volume of a straight trace', () => {
    // 1 mm wide, 10 mm long channel: straight rims 2·10·c²/2, round ends form a cone ring π·c²·(R + c/3).
    const c = 0.2;
    const expected = 2 * 10 * (c * c) / 2 + Math.PI * c * c * (0.5 + c / 3);
    expect(removed(single(['%ADD10C,1.0*%', 'D10*', 'X0Y0D02*', 'X10000000Y0D01*']), c)).toBeCloseTo(expected, 4);
  });

  it('matches the analytic chamfer volume of a rectangular pad', () => {
    // 2×2 mm pad: four straight rims plus four conical corners (π·c³/3 in total).
    const c = 0.2;
    const expected = 4 * 2 * (c * c) / 2 + (Math.PI * c ** 3) / 3;
    expect(removed(single(['%ADD10R,2.0X2.0*%', 'D10*', 'X0Y0D03*']), c)).toBeCloseTo(expected, 3);
  });

  it('limits the chamfer to the channel depth', () => {
    const r = build({ sides: 'top', mode: 'recessed', traceDepth: 0.3, channelChamfer: 0.5 });
    expect(r.warnings.some((w) => w.includes('limited to 0.25'))).toBe(true);
  });
});

describe('exports', () => {
  it('writes STEP, STL and 3MF', async () => {
    const r = build({ sides: 'both', mode: 'raised', stampEnabled: true });
    const step = await previewStep(r, { layout: 'print', showStamps: true }).text();
    expect(step).toContain('MANIFOLD_SOLID_BREP');
    const assembled = await previewStep(r, { layout: 'assembled', showStamps: true }).text();
    expect(assembled).toContain('MANIFOLD_SOLID_BREP');

    const stl = await exportParts(r, 'topHalf', 'stl', 0.01, 0.1);
    const tris = new DataView(stl.data.buffer).getUint32(80, true);
    expect(tris).toBeGreaterThan(100);
    expect(stl.data.length).toBe(84 + tris * 50);

    const mf = await exportParts(r, 'topHalf', '3mf', 0.01, 0.1);
    const files = unzipSync(mf.data);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const model = strFromU8(files['3D/3dmodel.model']);
    expect(model.match(/<object /g)).toHaveLength(3);
    expect(model).toContain('unit="millimeter"');

    const all = await exportParts(r, 'all', 'step', 0.01, 0.1);
    expect(Object.keys(unzipSync(all.data)).sort()).toEqual([
      'demo-bottomHalf.step',
      'demo-dowels.step',
      'demo-stampBottom.step',
      'demo-stampTop.step',
      'demo-topHalf.step',
    ]);
  });

  it('produces closed meshes', () => {
    const r = build({ sides: 'top', mode: 'recessed' });
    const shape = r.parts[0].bodies[0].shape;
    const m = (shape as any).mesh({ tolerance: 0.01, angularTolerance: 0.1 });
    // Every edge of a closed, welded mesh is shared by exactly two triangles.
    const key = (i: number) => [0, 1, 2].map((k) => m.vertices[i * 3 + k].toFixed(4)).join(',');
    const edges = new Map<string, number>();
    for (let i = 0; i < m.triangles.length; i += 3) {
      const t = [key(m.triangles[i]), key(m.triangles[i + 1]), key(m.triangles[i + 2])];
      for (let k = 0; k < 3; k++) {
        const e = [t[k], t[(k + 1) % 3]].sort().join('|');
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    }
    expect([...edges.values()].filter((n) => n !== 2).length).toBe(0);
    expect(measureArea(shape)).toBeGreaterThan(0);
  });
});
