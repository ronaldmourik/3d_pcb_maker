import { describe, expect, it } from 'vitest';
import { fixture, fixtureLayers } from './helpers';
import { parseGerber } from '../src/gerber/gerber';
import { parseExcellon } from '../src/gerber/drills';
import { buildOutline } from '../src/gerber/outline';
import { identifyRole, boardName } from '../src/gerber/loadFiles';
import { evalMacroExpr } from '../src/gerber/macroExpr';
import { contourPoints, polygonArea } from '../src/gerber/geom2d';
import { pourGerber, twoZonesGerber } from './pourFixture';

describe('layer identification', () => {
  it('detects KiCad roles', () => {
    const roles = Object.fromEntries(fixtureLayers().map((l) => [l.fileName, l.role]));
    expect(roles).toEqual({
      'demo-F_Cu.gbr': 'top-copper',
      'demo-B_Cu.gbr': 'bottom-copper',
      'demo-Edge_Cuts.gbr': 'outline',
      'demo-PTH.drl': 'drill',
    });
  });
  it('uses file name patterns without X2 attributes', () => {
    expect(identifyRole('board.GTL')).toBe('top-copper');
    expect(identifyRole('board.GBL')).toBe('bottom-copper');
    expect(identifyRole('board.GKO')).toBe('outline');
    expect(identifyRole('board-F_Mask.gbr')).toBe('ignore');
    expect(identifyRole('x', 'Copper,L2,Inr')).toBe('ignore');
  });
  it('derives the board name', () => {
    expect(boardName(fixtureLayers())).toBe('demo');
  });
});

describe('gerber parser', () => {
  it('parses pads, traces, arcs, macros and regions', () => {
    const r = parseGerber(fixture('demo-F_Cu.gbr'));
    expect(r.warnings).toEqual([]);
    expect(r.fileFunction).toBe('Copper,L1,Top');
    const kinds: Record<string, number> = {};
    for (const p of r.primitives) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    // circle pad + 4 round-rect corners; strokes: 2 + 4; contours: rect, obround, roundrect body + 4 edges, region
    expect(kinds).toEqual({ circle: 5, stroke: 6, contour: 8 });
    const arc = r.primitives.find((p) => p.kind === 'stroke' && p.seg.type === 'arc');
    expect(arc && arc.kind === 'stroke' && arc.seg.type === 'arc' && arc.seg.center).toEqual([115, -100]);
  });
  it('handles inch units, trailing zero omission and clear polarity', () => {
    const r = parseGerber('%FSTAX24Y24*%%MOIN*%%ADD10C,0.1*%D10*X01Y01D03*%LPC*%X02Y01D03*M02*');
    expect(r.primitives).toHaveLength(2);
    const [a, b] = r.primitives;
    expect(a.kind === 'circle' && a.center[0]).toBeCloseTo(25.4); // X01 with trailing zeros omitted = 1 inch
    expect(a.kind === 'circle' && a.r).toBeCloseTo(1.27);
    expect(b.dark).toBe(false);
  });
  it('evaluates macro expressions', () => {
    const vars = new Map([
      [1, 2],
      [2, 3],
    ]);
    expect(evalMacroExpr('$1+$1x$2', vars)).toBe(8);
    expect(evalMacroExpr('($1+$1)x$2/-2', vars)).toBe(-6);
  });
});

describe('excellon parser', () => {
  it('parses holes and slots', () => {
    const r = parseExcellon(fixture('demo-PTH.drl'));
    expect(r.drills).toHaveLength(6);
    expect(r.drills.filter((d) => d.to)).toHaveLength(1);
    expect(r.drills.find((d) => d.diameter === 3)?.at).toEqual([112, -92]);
  });
  it('parses integer coordinates with suppressed leading zeros', () => {
    const r = parseExcellon('M48\nINCH,TZ\nT1C0.04\n%\nT1\nX01Y02\nM30');
    expect(r.drills[0].at[0]).toBeCloseTo(0.0001 * 25.4);
    expect(r.drills[0].diameter).toBeCloseTo(1.016);
  });
});

describe('outline', () => {
  it('chains Edge.Cuts into one closed loop', () => {
    const r = buildOutline(parseGerber(fixture('demo-Edge_Cuts.gbr')).primitives);
    expect(r.openSegments).toBe(0);
    expect(r.shapes).toHaveLength(1);
    const area = Math.abs(polygonArea(contourPoints(r.shapes[0].outer, Math.PI / 720)));
    expect(area).toBeCloseTo(1200 - 9 + (Math.PI * 9) / 4, 1);
  });
});

describe('filled zone detection', () => {
  const zones = (text: string) => parseGerber(text).primitives.filter((p) => p.kind === 'contour' && p.zone).length;
  it('uses the X2 aperture function', () => {
    expect(zones(fixture('ketel_opto_solid/ketel_opto-B_Cu.gbr'))).toBe(1);
    expect(zones(twoZonesGerber())).toBe(2);
  });
  it('falls back to geometry without attributes', () => {
    expect(zones(fixture('ketel_opto_solid/ketel_opto-B_Cu.gbr').replace(/%T[AOD][^%]*%/g, ''))).toBe(1);
    expect(zones(pourGerber())).toBe(1);
  });
  it('does not mistake pads for zones', () => {
    for (const f of ['demo-F_Cu.gbr', 'demo-B_Cu.gbr', 'ketel_opto_double/ketel_opto-B_Cu.gbr', 'ketel_opto_double/ketel_opto-F_Cu.gbr', 'ketel_opto_solid/ketel_opto-F_Cu.gbr'])
      expect(zones(fixture(f)), f).toBe(0);
  });
});
