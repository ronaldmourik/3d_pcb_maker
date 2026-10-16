import { beforeAll, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { measureArea, measureVolume } from 'replicad';
import { fixtureInput, initOC } from './helpers';
import { parseLayerFile, toBoardInput } from '../src/gerber/loadFiles';
import { patternBounds } from '../src/export/paths2d';
import { buildModel, type BuildResult } from '../src/geometry/brep';
import { exportParts, previewIssueSpots, previewStep } from '../src/geometry/output';
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

  const raisedRemoved = (input: ReturnType<typeof single>, c: number) => {
    const v = (cc: number) => {
      const r = buildModel(input, { ...defaultSettings, sides: 'top', mode: 'raised', channelChamfer: cc, holes: false });
      const copper = r.parts[0].bodies[1].shape;
      expect(isValid(copper.wrapped)).toBe(true);
      expect(r.warnings.filter((w) => w.includes('hamfer'))).toEqual([]);
      return measureVolume(copper);
    };
    return v(0) - v(c);
  };

  it('bevels a raised trace exactly', () => {
    // Straight edges 2·10·c²/2, round caps (convex, R = 0.5): π·c²·(R − c/3).
    const c = 0.2;
    // Within 0.3 %: the tools' 0.1 µm flat bottom (FLAT in chamfer.ts) widens the bevel by ~0.2 µm.
    const expected = 2 * 10 * (c * c) / 2 + Math.PI * c * c * (0.5 - c / 3);
    const got = raisedRemoved(single(['%ADD10C,1.0*%', 'D10*', 'X0Y0D02*', 'X10000000Y0D01*']), c);
    expect(Math.abs(got - expected) / expected).toBeLessThan(0.003);
  });

  it('bevels a raised rectangular pad exactly (corners included)', () => {
    // Inward offset of a 2×2 square loses P·t − 4t² area: ∫0..c = P·c²/2 − 4c³/3.
    const c = 0.2;
    const expected = (8 * c * c) / 2 - (4 * c ** 3) / 3;
    expect(raisedRemoved(single(['%ADD10R,2.0X2.0*%', 'D10*', 'X0Y0D03*']), c)).toBeCloseTo(expected, 3);
  });

  it('limits the chamfer to the channel depth', () => {
    const r = build({ sides: 'top', mode: 'recessed', traceDepth: 0.3, channelChamfer: 0.5 });
    expect(r.warnings.some((w) => w.includes('limited to 0.25'))).toBe(true);
  });
});

describe('printability check', () => {
  const gerber = [
    '%FSLAX46Y46*%',
    '%MOMM*%',
    // KiCad round-rect macro: built from small corner circles/strokes, must not be flagged as tiny.
    '%AMRoundRect*0 Rectangle with rounded corners*4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*1,1,$1+$1,$2,$3*1,1,$1+$1,$4,$5*1,1,$1+$1,$6,$7*1,1,$1+$1,$8,$9*20,1,$1+$1,$2,$3,$4,$5,0*20,1,$1+$1,$4,$5,$6,$7,0*20,1,$1+$1,$6,$7,$8,$9,0*20,1,$1+$1,$8,$9,$2,$3,0*%',
    '%ADD10C,0.300000*%',
    '%ADD11C,2.000000*%',
    '%ADD12R,0.500000X0.500000*%',
    '%ADD13C,0.800000*%',
    '%ADD14RoundRect,0.250000X-0.750000X-0.750000X0.750000X-0.750000X0.750000X0.750000X-0.750000X0.750000X0*%',
    'D10*', 'X0Y0D02*', 'X10000000Y0D01*', // 0.3 mm trace
    'D11*', 'X20000000Y0D03*', 'X22200000Y0D03*', // 0.2 mm gap between pads
    'D12*', 'X30000000Y0D03*', // 0.5 mm pad
    'D13*', 'X0Y10000000D02*', 'X10000000Y10000000D01*', // exactly 2 × nozzle: fine
    'D14*', 'X40000000Y0D03*', // 1.5 mm round-rect pad: fine
    'M02*',
  ].join(String.fromCharCode(10));
  const drill = ['M48', 'METRIC', 'T1C0.500', 'T2C1.000', '%', 'T1', 'X50.0Y0.0', 'T2', 'X0.0Y10.0', 'M30'].join(String.fromCharCode(10));
  const input = () => toBoardInput([parseLayerFile('drc-F_Cu.gbr', gerber), parseLayerFile('drc.drl', drill)]);

  it('reports narrow traces, small features, tight gaps and small holes at their location', () => {
    const r = buildModel(input(), { ...defaultSettings, sides: 'top' });
    const found = r.issues.map((i) => [i.message.split(' ')[0], +i.at[0].toFixed(2) + 0, +i.at[1].toFixed(2) + 0]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['Trace', 5, 0],
        ['Gap', 21.1, 0],
        ['Copper', 30, 0],
        ['Hole', 50, 0],
      ]),
    );
    expect(found).toHaveLength(4);
    expect(r.issues.find((i) => i.message.startsWith('Gap'))!.message).toContain('0.20 mm');
  });

  it('is quiet on the real boards and can be switched off', () => {
    const real = buildModel(fixtureInput(), { ...defaultSettings, sides: 'both' });
    expect(real.issues).toEqual([]);
    expect(buildModel(input(), { ...defaultSettings, sides: 'top', printCheck: false }).issues).toEqual([]);
  });

  it('warns about a thin channel floor', () => {
    const r = build({ sides: 'top', mode: 'recessed', boardThickness: 0.6, traceDepth: 0.4 });
    expect(r.warnings.some((w) => w.includes('material under the channels'))).toBe(true);
  });
});

describe('copper cut patterns (SVG / DXF)', () => {
  const trace = () =>
    toBoardInput([
      parseLayerFile('t-F_Cu.gbr', ['%FSLAX46Y46*%', '%MOMM*%', '%ADD10C,1.0*%', 'D10*', 'X0Y0D02*', 'X10000000Y0D01*', 'M02*'].join(String.fromCharCode(10))),
    ]);
  const text = async (p: Promise<{ data: Uint8Array }>) => new TextDecoder().decode((await p).data);

  it('extracts the exact copper outline with arcs', () => {
    const r = buildModel(trace(), { ...defaultSettings, sides: 'top', margin: 1 });
    const p = r.cutPatterns.top!;
    expect(p.copper).toHaveLength(1);
    const kinds = p.copper[0].map((s) => s.type).sort();
    expect(kinds).toEqual(['arc', 'arc', 'line', 'line']);
    const b = patternBounds({ ...p, outline: [], holes: [], slots: [] });
    expect([b.minX, b.minY, b.maxX, b.maxY].map((v) => +v.toFixed(6) + 0)).toEqual([-0.5, -0.5, 10.5, 0.5]);
  });

  it('writes DXF lines and counter-clockwise arcs', async () => {
    const r = buildModel(trace(), { ...defaultSettings, sides: 'top', margin: 1 });
    const dxf = await text(exportParts(r, 'copperTop', 'dxf', 0.01, 0.1));
    const lines = dxf.split('\n');
    const entities = lines.flatMap((l, i) => (l === '0' && ['LINE', 'ARC', 'CIRCLE'].includes(lines[i + 1]) ? [[lines[i + 1], lines[i + 3]]] : []));
    expect(entities.filter(([, layer]) => layer === 'COPPER').map(([t]) => t).sort()).toEqual(['ARC', 'ARC', 'LINE', 'LINE']);
    expect(entities.filter(([, layer]) => layer === 'OUTLINE')).toHaveLength(4);
    // Arc caps: right cap runs 270°→90°, left cap 90°→270° (counter-clockwise in DXF).
    const arcs = lines.flatMap((l, i) => (l === 'ARC' ? [[+lines[i + 12], +lines[i + 14]]] : []));
    expect(arcs.map(([a, b]) => [Math.round(a), Math.round(b)]).sort()).toEqual([
      [270, 90],
      [90, 270],
    ]);
    expect(dxf.trim().endsWith('EOF')).toBe(true);
  });

  it('writes a 1:1 SVG in millimetres', async () => {
    const r = buildModel(trace(), { ...defaultSettings, sides: 'top', margin: 1 });
    const svg = await text(exportParts(r, 'copperTop', 'svg', 0.01, 0.1));
    // Board box -1.5..11.5 × -1.5..1.5 plus 2 mm margin on each side.
    expect(svg).toContain('width="17mm" height="7mm" viewBox="0 0 17 7"');
    const copper = /<g id="copper"[^>]*>([\s\S]*?)<\/g>/.exec(svg)![1];
    expect(copper.match(/A0\.5 0\.5/g)).toHaveLength(2);
  });

  it('orients bottom patterns as printed and can mirror them again', () => {
    const r = build({ sides: 'both', mode: 'raised' });
    // The slot at x≈138 (board centre 120) is at x≈102 on the mirrored bottom pattern.
    const slotX = (p: NonNullable<typeof r.cutPatterns.top>) => p.slots[0][0].a[0];
    expect(slotX(r.cutPatterns.top!)).toBeGreaterThan(137);
    expect(slotX(r.cutPatterns.bottom!)).toBeLessThan(103);
  });
});

describe('issue locations', () => {
  it('maps board coordinates into the preview layouts', () => {
    const r = build({ sides: 'both', mode: 'raised' });
    // Board spans x 100..140 (centre 120), halves are 0.8 mm + 0.4 mm copper.
    r.issues.push({ message: 't', side: 'top', at: [110, -90] }, { message: 'b', side: 'bottom', at: [110, -90] });
    const print = previewIssueSpots(r, { layout: 'print', showStamps: false });
    expect(print[0].at).toEqual([110, -90, expect.closeTo(1.2, 5)]);
    // Bottom half is mirrored about x=120 and shifted right by width + gap (40 + 8).
    expect(print[1].at[0]).toBeCloseTo(130 + 48, 5);
    const asm = previewIssueSpots(r, { layout: 'assembled', showStamps: false });
    expect(asm[1].at).toEqual([110, -90, expect.closeTo(-1.2, 5)]);
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
