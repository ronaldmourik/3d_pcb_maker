// Exact 2D geometry extracted from Gerber / Excellon files. All units are mm.

export type Pt = [number, number];

/** A path segment starting at the previous point. Arcs keep their true center. */
export type Seg =
  | { type: 'line'; end: Pt }
  | { type: 'arc'; end: Pt; center: Pt; cw: boolean };

/** A closed contour: start point followed by segments that end back at start. */
export interface Contour {
  start: Pt;
  segs: Seg[];
}

export type Primitive =
  /** A circular-aperture stroke along one segment (line or arc). */
  | { kind: 'stroke'; dark: boolean; from: Pt; seg: Seg; width: number }
  | { kind: 'circle'; dark: boolean; center: Pt; r: number }
  /** Arbitrary filled shape: rect/obround/polygon pads, macros, regions. */
  | { kind: 'contour'; dark: boolean; outer: Contour; holes?: Contour[] };

export type LayerRole = 'top-copper' | 'bottom-copper' | 'silk-top' | 'silk-bottom' | 'outline' | 'drill' | 'ignore';

export interface Drill {
  /** Center of a round hole, or start of a slot. */
  at: Pt;
  /** End point for slots (oval / routed holes). */
  to?: Pt;
  diameter: number;
}

export interface ParsedLayer {
  id: string;
  fileName: string;
  role: LayerRole;
  /** Role detected automatically (before user override). */
  detectedRole: LayerRole;
  kind: 'gerber' | 'drill' | 'unknown';
  primitives: Primitive[];
  drills: Drill[];
  warnings: string[];
  /** X2 file function (e.g. "Copper,L1,Top"), if present. */
  fileFunction?: string;
}

/** What the geometry worker needs: layers grouped by role. */
export interface BoardInput {
  name: string;
  top: Primitive[] | null;
  bottom: Primitive[] | null;
  silkTop?: Primitive[] | null;
  silkBottom?: Primitive[] | null;
  outline: Primitive[] | null;
  drills: Drill[];
}
