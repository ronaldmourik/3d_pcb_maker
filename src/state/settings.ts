// Generation parameters. The UI edits a draft copy; only applied settings drive a build.

export type Mode = 'raised' | 'recessed' | 'conductive' | 'groove';
export type Sides = 'top' | 'bottom' | 'both';

export interface Settings {
  mode: Mode;
  sides: Sides;
  boardThickness: number;
  traceHeight: number;
  traceDepth: number;
  /** Chamfer on the top rim of recessed channels; 0 = sharp. */
  channelChamfer: number;
  /** Groove mode: width of the tear groove around the (flush) traces, outward from the trace edge. */
  grooveWidth: number;
  /** Groove mode: depth of that groove. */
  grooveDepth: number;
  copperOffset: number;

  holes: boolean;
  holeOffset: number;
  minHoleDiameter: number;

  outlineSource: 'edge-cuts' | 'bounding-box';
  margin: number;

  alignmentDowels: boolean;
  dowelCount: number;
  dowelDiameter: number;
  dowelDepth: number;
  dowelClearance: number;
  dowelEdgeMargin: number;

  stampEnabled: boolean;
  stampThickness: number;
  stampClearance: number;
  tapeThickness: number;
  /** Rib height (recessed), pocket depth (raised) or ridge height (groove); 0 = automatic. */
  stampFeatureOverride: number;
  alignmentPins: boolean;
  pinMinHoleDiameter: number;
  pinClearance: number;
  pinLength: number;
  cuttingRidge: boolean;
  ridgeWidth: number;
  ridgeHeight: number;

  meshTolerance: number;
  angularTolerance: number;
  mergeBodies: boolean;

  /** Conductive filament: traces embedded flush (two-material print) or standing on top. */
  conductiveEmbed: boolean;
  /** Filament volume resistivity in Ω·cm. */
  conductiveResistivity: number;
  conductiveMinWidth: number;

  /** Silkscreen marks on the copper face. */
  silkMode: 'off' | 'engrave' | 'emboss';
  silkDepth: number;
  silkClearance: number;
  silkMinWidth: number;
  /** Print the marks as their own body in a second filament (multi-material 3MF). */
  silkSeparate: boolean;
  /** Colour of that filament (preview and 3MF material). */
  silkColor: string;

  /** Printability check against the printer nozzle. */
  printCheck: boolean;
  nozzleDiameter: number;
  minGap: number;
}

export const defaultSettings: Settings = {
  mode: 'recessed',
  sides: 'top',
  boardThickness: 1.6,
  traceHeight: 0.4,
  traceDepth: 0.4,
  channelChamfer: 0,
  grooveWidth: 0.8,
  grooveDepth: 0.6,
  copperOffset: 0,

  holes: true,
  holeOffset: 0.1,
  minHoleDiameter: 0,

  outlineSource: 'edge-cuts',
  margin: 2,

  alignmentDowels: true,
  dowelCount: 4,
  dowelDiameter: 3,
  dowelDepth: 1,
  dowelClearance: 0.15,
  dowelEdgeMargin: 1.5,

  stampEnabled: false,
  stampThickness: 2,
  stampClearance: 0.1,
  tapeThickness: 0.06,
  stampFeatureOverride: 0,
  alignmentPins: true,
  pinMinHoleDiameter: 2,
  pinClearance: 0.15,
  pinLength: 2,
  cuttingRidge: false,
  ridgeWidth: 0.4,
  ridgeHeight: 0.3,

  meshTolerance: 0.01,
  angularTolerance: 0.1,
  mergeBodies: false,

  conductiveEmbed: true,
  conductiveResistivity: 15,
  conductiveMinWidth: 1.5,

  silkMode: 'engrave',
  silkDepth: 0.3,
  silkClearance: 0.3,
  silkMinWidth: 0.4,
  silkSeparate: false,
  silkColor: '#1a1a1a',

  printCheck: true,
  nozzleDiameter: 0.4,
  minGap: 0.5,
};

export function settingsEqual(a: Settings, b: Settings): boolean {
  return (Object.keys(a) as (keyof Settings)[]).every((k) => a[k] === b[k]);
}

/** Restrict `sides` to the copper layers that are actually available. */
export function resolveSides(s: Sides, hasTop: boolean, hasBottom: boolean): Sides | null {
  if (hasTop && hasBottom) return s;
  if (hasTop) return 'top';
  if (hasBottom) return 'bottom';
  return null;
}
