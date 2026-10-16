// Plain 2D path data (no OpenCascade objects) for cutter exports: closed loops of lines and arcs.
export type P2 = [number, number];

export type PathSeg =
  | { type: 'line'; a: P2; b: P2 }
  /** Arc through three points (start, a point on the arc, end). */
  | { type: 'arc'; a: P2; m: P2; b: P2 };

export interface CutPattern {
  /** Copper outlines (outer boundaries and inner holes). */
  copper: PathSeg[][];
  /** Board outline, for registration. */
  outline: PathSeg[][];
  /** Drill holes as circles. */
  holes: { c: P2; r: number }[];
  /** Slotted holes as closed loops. */
  slots: PathSeg[][];
}

export function circleFrom3(a: P2, m: P2, b: P2): { c: P2; r: number; ccw: boolean } | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const m2 = m[0] * m[0] + m[1] * m[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const cx = (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d;
  const cy = (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d;
  // Orientation of a → m → b decides the travel direction.
  const cross = (m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]);
  return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy), ccw: cross < 0 ? false : true };
}

/** Start/end angle (radians) and signed sweep of a three-point arc. */
export function arcAngles(a: P2, m: P2, b: P2): { c: P2; r: number; start: number; sweep: number } | null {
  const circ = circleFrom3(a, m, b);
  if (!circ) return null;
  const { c, r, ccw } = circ;
  const start = Math.atan2(a[1] - c[1], a[0] - c[0]);
  const end = Math.atan2(b[1] - c[1], b[0] - c[0]);
  let sweep = ccw ? end - start : start - end;
  while (sweep <= 1e-12) sweep += 2 * Math.PI;
  return { c, r, start, sweep: ccw ? sweep : -sweep };
}

/** Points on the arc where x or y is extreme (axis crossings inside the sweep). */
function arcExtremes(a: P2, m: P2, b: P2): P2[] {
  const g = arcAngles(a, m, b);
  if (!g) return [];
  const out: P2[] = [];
  for (let k = -4; k <= 4; k++) {
    const ang = (k * Math.PI) / 2;
    const rel = g.sweep > 0 ? ang - g.start : g.start - ang;
    const norm = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (norm <= Math.abs(g.sweep)) out.push([g.c[0] + g.r * Math.cos(ang), g.c[1] + g.r * Math.sin(ang)]);
  }
  return out;
}

export function mapPattern(p: CutPattern, f: (q: P2) => P2): CutPattern {
  const seg = (s: PathSeg): PathSeg => (s.type === 'line' ? { type: 'line', a: f(s.a), b: f(s.b) } : { type: 'arc', a: f(s.a), m: f(s.m), b: f(s.b) });
  return {
    copper: p.copper.map((l) => l.map(seg)),
    outline: p.outline.map((l) => l.map(seg)),
    holes: p.holes.map((h) => ({ c: f(h.c), r: h.r })),
    slots: p.slots.map((l) => l.map(seg)),
  };
}

export function patternBounds(p: CutPattern): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (q: P2, pad = 0) => {
    minX = Math.min(minX, q[0] - pad);
    minY = Math.min(minY, q[1] - pad);
    maxX = Math.max(maxX, q[0] + pad);
    maxY = Math.max(maxY, q[1] + pad);
  };
  for (const loop of [...p.copper, ...p.outline, ...p.slots])
    for (const s of loop) {
      add(s.a);
      add(s.b);
      if (s.type === 'arc') for (const q of arcExtremes(s.a, s.m, s.b)) add(q);
    }
  for (const h of p.holes) add(h.c, h.r);
  return { minX, minY, maxX, maxY };
}
