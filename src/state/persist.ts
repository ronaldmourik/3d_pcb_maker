// Remembers settings, view options and user presets in localStorage (versioned, with migration).
import { defaultSettings, type Settings } from './settings';

const KEY = 'pcb-maker:v1';
const VERSION = 1;

export interface Preset {
  name: string;
  builtIn?: boolean;
  values: Partial<Settings>;
}

export interface Stored {
  version: number;
  draft: Settings;
  preview?: { layout: 'print' | 'assembled'; showStamps: boolean };
  presets: Preset[];
}

const ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  mode: ['raised', 'recessed', 'conductive'],
  sides: ['top', 'bottom', 'both'],
  outlineSource: ['edge-cuts', 'bounding-box'],
  silkMode: ['off', 'engrave', 'emboss'],
};

/** Settings that depend on the uploaded files, not on the printer or taste: never part of a preset. */
const FILE_DEPENDENT: (keyof Settings)[] = ['sides', 'outlineSource'];

/** Keep only known keys with the right type (and valid enum values); fill the rest with defaults. */
export function migrateSettings(raw: unknown): Settings {
  const out: Settings = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(defaultSettings) as (keyof Settings)[]) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== typeof defaultSettings[k]) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    const allowed = ENUMS[k];
    if (allowed && !allowed.includes(v as string)) continue;
    if (k === 'silkColor' && !/^#[0-9a-f]{6}$/i.test(v as string)) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

export const BUILT_IN_PRESETS: Preset[] = [
  { name: '0.4 mm nozzle', builtIn: true, values: { nozzleDiameter: 0.4, minGap: 0.5, silkMinWidth: 0.4, conductiveMinWidth: 1.5 } },
  { name: '0.6 mm nozzle', builtIn: true, values: { nozzleDiameter: 0.6, minGap: 0.7, silkMinWidth: 0.6, conductiveMinWidth: 1.8 } },
  { name: 'Vinyl-cut tape', builtIn: true, values: { mode: 'raised', stampEnabled: false, channelChamfer: 0 } },
];

export function load(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Stored {
  const fallback: Stored = { version: VERSION, draft: { ...defaultSettings }, presets: [] };
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw) as Partial<Stored>;
    const presets = Array.isArray(data.presets)
      ? data.presets
          .filter((p): p is Preset => !!p && typeof p.name === 'string' && typeof p.values === 'object')
          .map((p) => ({ name: p.name, values: presetValues(migrateSettings({ ...defaultSettings, ...p.values })) }))
      : [];
    const preview =
      data.preview && (data.preview.layout === 'print' || data.preview.layout === 'assembled')
        ? { layout: data.preview.layout, showStamps: !!data.preview.showStamps }
        : undefined;
    return { version: VERSION, draft: migrateSettings(data.draft), preview, presets };
  } catch {
    return fallback;
  }
}

export function save(data: Omit<Stored, 'version'>, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(KEY, JSON.stringify({ ...data, version: VERSION, presets: data.presets.filter((p) => !p.builtIn) }));
  } catch {
    /* storage full or unavailable: not fatal */
  }
}

/** The part of the settings a preset stores. */
export function presetValues(s: Settings): Partial<Settings> {
  const v: Partial<Settings> = { ...s };
  for (const k of FILE_DEPENDENT) delete v[k];
  return v;
}

export function applyPreset(draft: Settings, p: Preset): Settings {
  const v = { ...p.values };
  for (const k of FILE_DEPENDENT) delete v[k];
  return { ...draft, ...v };
}
