import { describe, expect, it } from 'vitest';
import { applyPreset, BUILT_IN_PRESETS, load, migrateSettings, presetValues, save } from '../src/state/persist';
import { defaultSettings } from '../src/state/settings';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('settings persistence', () => {
  it('fills new keys with defaults and drops invalid values', () => {
    const s = migrateSettings({ nozzleDiameter: 0.6, mode: 'laser', boardThickness: 'thick', holeOffset: NaN, unknown: 1 });
    expect(s.nozzleDiameter).toBe(0.6);
    expect(s.mode).toBe(defaultSettings.mode);
    expect(s.boardThickness).toBe(defaultSettings.boardThickness);
    expect(s.holeOffset).toBe(defaultSettings.holeOffset);
    expect('unknown' in s).toBe(false);
    expect(Object.keys(s).sort()).toEqual(Object.keys(defaultSettings).sort());
  });

  it('keeps the cut groove mode and its dimensions', () => {
    const s = migrateSettings({ mode: 'groove', grooveWidth: 1, grooveDepth: 0.5 });
    expect([s.mode, s.grooveWidth, s.grooveDepth]).toEqual(['groove', 1, 0.5]);
  });

  it('round-trips draft, view and user presets (but not built-ins)', () => {
    const st = memory();
    const draft = { ...defaultSettings, mode: 'raised' as const, traceHeight: 0.6 };
    save({ draft, preview: { layout: 'assembled', showStamps: false }, presets: [...BUILT_IN_PRESETS, { name: 'Mine', values: { stampEnabled: true } }] }, st);
    const stored = JSON.parse([...st.data.values()][0]);
    expect(stored.presets.map((p: { name: string }) => p.name)).toEqual(['Mine']);
    const back = load(st);
    expect(back.draft).toEqual(draft);
    expect(back.preview).toEqual({ layout: 'assembled', showStamps: false });
    expect(back.presets[0].name).toBe('Mine');
    expect(back.presets[0].values.stampEnabled).toBe(true);
  });

  it('survives corrupt storage', () => {
    const st = memory();
    st.setItem('pcb-maker:v1', '{not json');
    expect(load(st).draft).toEqual(defaultSettings);
  });

  it('presets never change file-dependent choices', () => {
    const draft = { ...defaultSettings, sides: 'both' as const, outlineSource: 'bounding-box' as const };
    const preset = { name: 'p', values: { ...defaultSettings, sides: 'top' as const, nozzleDiameter: 0.6 } };
    const r = applyPreset(draft, preset);
    expect(r.sides).toBe('both');
    expect(r.outlineSource).toBe('bounding-box');
    expect(r.nozzleDiameter).toBe(0.6);
    expect('sides' in presetValues(draft)).toBe(false);
  });
});
