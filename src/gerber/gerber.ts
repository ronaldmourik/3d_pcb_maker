// Gerber RS-274X parser producing exact primitives (arcs are kept as arcs).
import type { Contour, Primitive, Pt, Seg } from './types';
import { evalMacroExpr } from './macroExpr';

interface Format {
  intDigits: number;
  decDigits: number;
  omitTrailing: boolean;
  incremental: boolean;
}

type Aperture =
  | { type: 'C'; d: number }
  | { type: 'R'; w: number; h: number }
  | { type: 'O'; w: number; h: number }
  | { type: 'P'; d: number; n: number; rot: number }
  | { type: 'M'; macro: string; params: number[] };

export interface GerberResult {
  primitives: Primitive[];
  warnings: string[];
  fileFunction?: string;
}

const DEG = Math.PI / 180;

export function parseGerber(text: string): GerberResult {
  const p = new GerberParser();
  p.parse(text);
  return { primitives: p.out, warnings: [...new Set(p.warnings)], fileFunction: p.fileFunction };
}

/** Quick check whether a text file looks like a Gerber file. */
export function looksLikeGerber(text: string): boolean {
  return /%FS[LT]?[AI]X\d\dY\d\d/.test(text) || /%MO(MM|IN)\*%/.test(text) || /%ADD\d+/.test(text);
}

class GerberParser {
  out: Primitive[] = [];
  warnings: string[] = [];
  fileFunction?: string;

  private fmt: Format = { intDigits: 3, decDigits: 6, omitTrailing: false, incremental: false };
  private scale = 25.4; // inch until MO says otherwise
  private apertures = new Map<number, Aperture>();
  private macros = new Map<string, string[]>();
  private aperture: number | null = null;
  private interp: 'G01' | 'G02' | 'G03' = 'G01';
  private singleQuadrant = false;
  private dark = true;
  private x = 0;
  private y = 0;
  private lastD = 2;
  private region: { contours: Contour[]; current: Contour | null } | null = null;
  private srStack: { target: Primitive[]; nx: number; ny: number; dx: number; dy: number } | null = null;
  private target: Primitive[] = this.out;

  parse(text: string) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '%') {
        const end = text.indexOf('%', i + 1);
        if (end < 0) break;
        this.extended(text.slice(i + 1, end).replace(/\s+/g, ''));
        i = end + 1;
      } else if (c === '\r' || c === '\n' || c === ' ' || c === '\t') {
        i++;
      } else {
        const end = text.indexOf('*', i);
        if (end < 0) break;
        this.word(text.slice(i, end).replace(/[\r\n]/g, ''));
        i = end + 1;
      }
    }
    this.closeStepRepeat();
  }

  private warn(msg: string) {
    this.warnings.push(msg);
  }

  // ---- extended (%...%) commands ----
  private extended(block: string) {
    if (block.startsWith('AM')) {
      const stmts = block.split('*').filter((s) => s.length);
      const name = stmts[0].slice(2);
      this.macros.set(name, stmts.slice(1));
      return;
    }
    for (const stmt of block.split('*')) {
      if (!stmt) continue;
      const code = stmt.slice(0, 2);
      switch (code) {
        case 'FS': {
          const m = /^FS([LTD]?)([AI])X(\d)(\d)Y(\d)(\d)/.exec(stmt);
          if (m) {
            this.fmt = {
              omitTrailing: m[1] === 'T',
              incremental: m[2] === 'I',
              intDigits: +m[3],
              decDigits: +m[4],
            };
          }
          break;
        }
        case 'MO':
          this.scale = stmt.startsWith('MOIN') ? 25.4 : 1;
          break;
        case 'AD':
          this.defineAperture(stmt);
          break;
        case 'LP':
          this.dark = stmt[2] !== 'C';
          break;
        case 'SR':
          this.stepRepeat(stmt);
          break;
        case 'TF': {
          const m = /^TF\.FileFunction,(.*)$/.exec(stmt);
          if (m) this.fileFunction = m[1];
          break;
        }
        case 'IP':
          if (stmt.includes('NEG')) this.warn('Negative image polarity (IPNEG) is not supported.');
          break;
        case 'AB':
          this.warn('Block apertures (AB) are not supported and were ignored.');
          break;
        case 'LM':
        case 'LR':
        case 'LS':
          if (!/^(LMN|LR0(\.0*)?|LS1(\.0*)?)$/.test(stmt)) this.warn(`Aperture transform ${stmt} is not supported.`);
          break;
        case 'G0':
        case 'G7':
          this.word(stmt);
          break;
        default:
          break; // TA/TO/TD/IN/LN/OF/AS... are irrelevant for geometry
      }
    }
  }

  private defineAperture(stmt: string) {
    const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(stmt);
    if (!m) return;
    const id = +m[1];
    const name = m[2];
    const params = m[3] ? m[3].split('X').map((v) => parseFloat(v)) : [];
    const s = this.scale;
    let ap: Aperture | null = null;
    if (name === 'C') ap = { type: 'C', d: (params[0] ?? 0) * s };
    else if (name === 'R') ap = { type: 'R', w: params[0] * s, h: params[1] * s };
    else if (name === 'O') ap = { type: 'O', w: params[0] * s, h: params[1] * s };
    else if (name === 'P') ap = { type: 'P', d: params[0] * s, n: params[1], rot: params[2] ?? 0 };
    else if (this.macros.has(name)) ap = { type: 'M', macro: name, params: m[3] ? m[3].split('X').map(parseFloat) : [] };
    else this.warn(`Unknown aperture type "${name}".`);
    if (ap) this.apertures.set(id, ap);
  }

  private stepRepeat(stmt: string) {
    this.closeStepRepeat();
    const m = /^SRX(\d+)Y(\d+)I([\d.+-]+)J([\d.+-]+)/.exec(stmt);
    if (!m) return;
    const nx = +m[1];
    const ny = +m[2];
    if (nx === 1 && ny === 1) return;
    this.srStack = { target: [], nx, ny, dx: +m[3] * this.scale, dy: +m[4] * this.scale };
    this.target = this.srStack.target;
  }

  private closeStepRepeat() {
    const sr = this.srStack;
    if (!sr) return;
    this.srStack = null;
    this.target = this.out;
    for (let j = 0; j < sr.ny; j++)
      for (let i = 0; i < sr.nx; i++)
        for (const prim of sr.target) this.out.push(translatePrim(prim, i * sr.dx, j * sr.dy));
  }

  // ---- normal words ----
  private coord(v: string): number {
    if (v.includes('.')) return parseFloat(v) * this.scale;
    let neg = false;
    let s = v;
    if (s[0] === '+' || s[0] === '-') {
      neg = s[0] === '-';
      s = s.slice(1);
    }
    const total = this.fmt.intDigits + this.fmt.decDigits;
    if (this.fmt.omitTrailing) s = s.padEnd(total, '0');
    const val = parseInt(s, 10) / 10 ** this.fmt.decDigits;
    return (neg ? -val : val) * this.scale;
  }

  private word(w: string) {
    if (!w) return;
    if (/^G0?4/.test(w)) return; // comment
    if (w === 'M02' || w === 'M00' || w === 'M2') return;
    const re = /([GDMXYIJ])([+-]?[\d.]+)/g;
    let m: RegExpExecArray | null;
    let nx: number | null = null;
    let ny: number | null = null;
    let ci = 0;
    let cj = 0;
    let d: number | null = null;
    while ((m = re.exec(w))) {
      const [, letter, val] = m;
      if (letter === 'G') {
        const g = parseInt(val, 10);
        if (g === 1) this.interp = 'G01';
        else if (g === 2) this.interp = 'G02';
        else if (g === 3) this.interp = 'G03';
        else if (g === 74) this.singleQuadrant = true;
        else if (g === 75) this.singleQuadrant = false;
        else if (g === 36) this.region = { contours: [], current: null };
        else if (g === 37) this.endRegion();
        else if (g === 70) this.scale = 25.4;
        else if (g === 71) this.scale = 1;
        else if (g === 90) this.fmt.incremental = false;
        else if (g === 91) this.fmt.incremental = true;
      } else if (letter === 'X') nx = this.coord(val);
      else if (letter === 'Y') ny = this.coord(val);
      else if (letter === 'I') ci = this.coord(val);
      else if (letter === 'J') cj = this.coord(val);
      else if (letter === 'D') d = parseInt(val, 10);
    }
    if (d !== null && d >= 10) {
      this.aperture = d;
      return;
    }
    const hasCoord = nx !== null || ny !== null;
    if (d === null) {
      if (!hasCoord) return;
      d = this.lastD; // deprecated modal operation
    }
    this.lastD = d;
    let tx = nx ?? (this.fmt.incremental ? 0 : this.x);
    let ty = ny ?? (this.fmt.incremental ? 0 : this.y);
    if (this.fmt.incremental) {
      tx += this.x;
      ty += this.y;
    }
    const from: Pt = [this.x, this.y];
    const to: Pt = [tx, ty];
    if (d === 1) this.interpolate(from, to, ci, cj);
    else if (d === 2) this.move(to);
    else if (d === 3) this.flash(to);
    this.x = tx;
    this.y = ty;
  }

  private makeSeg(from: Pt, to: Pt, i: number, j: number): Seg {
    if (this.interp === 'G01') return { type: 'line', end: to };
    const cw = this.interp === 'G02';
    if (!this.singleQuadrant) return { type: 'arc', end: to, center: [from[0] + i, from[1] + j], cw };
    // Single quadrant: pick the sign combination giving a consistent arc of <= 90 degrees.
    let best: Pt = [from[0] + i, from[1] + j];
    let bestErr = Infinity;
    for (const sx of [1, -1])
      for (const sy of [1, -1]) {
        const c: Pt = [from[0] + sx * Math.abs(i), from[1] + sy * Math.abs(j)];
        const r1 = Math.hypot(from[0] - c[0], from[1] - c[1]);
        const r2 = Math.hypot(to[0] - c[0], to[1] - c[1]);
        const sweep = arcSweep(from, to, c, cw);
        if (sweep > Math.PI / 2 + 1e-6) continue;
        const err = Math.abs(r1 - r2);
        if (err < bestErr) {
          bestErr = err;
          best = c;
        }
      }
    return { type: 'arc', end: to, center: best, cw };
  }

  private interpolate(from: Pt, to: Pt, i: number, j: number) {
    const seg = this.makeSeg(from, to, i, j);
    if (this.region) {
      if (!this.region.current) this.region.current = { start: from, segs: [] };
      this.region.current.segs.push(seg);
      return;
    }
    const ap = this.aperture !== null ? this.apertures.get(this.aperture) : undefined;
    if (!ap) {
      this.warn('Draw with undefined aperture ignored.');
      return;
    }
    if (ap.type === 'C') {
      if (ap.d <= 0) return;
      if (seg.type === 'line' && samePt(from, to)) {
        this.emit({ kind: 'circle', dark: this.dark, center: from, r: ap.d / 2 });
      } else {
        this.emit({ kind: 'stroke', dark: this.dark, from, seg, width: ap.d });
      }
      return;
    }
    if (ap.type === 'R' && seg.type === 'line') {
      this.emit({ kind: 'contour', dark: this.dark, outer: rectSweep(from, to, ap.w, ap.h) });
      return;
    }
    // Other aperture/stroke combos are rare; approximate with a round stroke.
    const w = ap.type === 'R' || ap.type === 'O' ? Math.min(ap.w, ap.h) : ap.type === 'P' ? ap.d : 0.2;
    this.warn('Non-circular aperture strokes were approximated with round strokes.');
    this.emit({ kind: 'stroke', dark: this.dark, from, seg, width: w });
  }

  private move(to: Pt) {
    if (this.region) {
      this.closeContour();
      this.region.current = { start: to, segs: [] };
    }
  }

  private closeContour() {
    const r = this.region;
    if (!r || !r.current) return;
    const c = r.current;
    r.current = null;
    if (c.segs.length === 0) return;
    const last = c.segs[c.segs.length - 1].end;
    if (!samePt(last, c.start)) c.segs.push({ type: 'line', end: c.start });
    if (c.segs.length >= 2 || c.segs.some((s) => s.type === 'arc')) r.contours.push(c);
  }

  private endRegion() {
    if (!this.region) return;
    this.closeContour();
    for (const c of this.region.contours) this.emit({ kind: 'contour', dark: this.dark, outer: c });
    this.region = null;
  }

  private flash(at: Pt) {
    const ap = this.aperture !== null ? this.apertures.get(this.aperture) : undefined;
    if (!ap) {
      this.warn('Flash with undefined aperture ignored.');
      return;
    }
    for (const prim of this.apertureShapes(ap)) {
      // In clear polarity the aperture's exposed shapes erase; its own holes do nothing.
      if (!this.dark && !prim.dark) continue;
      const p = translatePrim(prim, at[0], at[1]);
      if (!this.dark) p.dark = false;
      this.emit(p);
    }
  }

  private emit(p: Primitive) {
    this.target.push(p);
  }

  private apertureShapes(ap: Aperture): Primitive[] {
    switch (ap.type) {
      case 'C':
        return ap.d > 0 ? [{ kind: 'circle', dark: true, center: [0, 0], r: ap.d / 2 }] : [];
      case 'R':
        return [{ kind: 'contour', dark: true, outer: rectContour(0, 0, ap.w, ap.h, 0) }];
      case 'O':
        if (Math.abs(ap.w - ap.h) < 1e-9) return [{ kind: 'circle', dark: true, center: [0, 0], r: ap.w / 2 }];
        return [{ kind: 'contour', dark: true, outer: obroundContour(ap.w, ap.h) }];
      case 'P':
        return [{ kind: 'contour', dark: true, outer: polygonContour(0, 0, ap.d / 2, ap.n, ap.rot) }];
      case 'M':
        return this.macroShapes(ap.macro, ap.params);
    }
  }

  private macroShapes(name: string, params: number[]): Primitive[] {
    const stmts = this.macros.get(name) ?? [];
    const vars = new Map<number, number>();
    params.forEach((v, i) => vars.set(i + 1, v));
    const s = this.scale;
    const res: Primitive[] = [];
    for (const raw of stmts) {
      const stmt = raw.trim();
      if (!stmt || stmt.startsWith('0')) continue;
      const vm = /^\$(\d+)=(.*)$/.exec(stmt);
      if (vm) {
        vars.set(+vm[1], evalMacroExpr(vm[2], vars));
        continue;
      }
      const parts = stmt.split(',');
      const code = parseInt(parts[0], 10);
      const a = parts.slice(1).map((e) => evalMacroExpr(e, vars));
      const on = (v: number) => v !== 0;
      try {
        switch (code) {
          case 1: {
            const [exp, dia, cx, cy, rot = 0] = a;
            const c = rotatePt([cx * s, cy * s], rot);
            res.push({ kind: 'circle', dark: on(exp), center: c, r: (dia * s) / 2 });
            break;
          }
          case 2:
          case 20: {
            const [exp, w, sx, sy, ex, ey, rot = 0] = a;
            const outer = rectSweepSquare([sx * s, sy * s], [ex * s, ey * s], w * s);
            res.push({ kind: 'contour', dark: on(exp), outer: rotateContour(outer, rot) });
            break;
          }
          case 21: {
            const [exp, w, h, cx, cy, rot = 0] = a;
            res.push({ kind: 'contour', dark: on(exp), outer: rotateContour(rectContour(cx * s, cy * s, w * s, h * s, 0), rot) });
            break;
          }
          case 22: {
            const [exp, w, h, lx, ly, rot = 0] = a;
            const outer = rectContour((lx + w / 2) * s, (ly + h / 2) * s, w * s, h * s, 0);
            res.push({ kind: 'contour', dark: on(exp), outer: rotateContour(outer, rot) });
            break;
          }
          case 4: {
            const [exp, nv] = a;
            const pts: Pt[] = [];
            for (let k = 0; k <= nv; k++) pts.push([a[2 + 2 * k] * s, a[3 + 2 * k] * s]);
            const rot = a[2 + 2 * (nv + 1)] ?? 0;
            const start = pts[0];
            const segs: Seg[] = pts.slice(1).map((pt) => ({ type: 'line', end: pt }) as Seg);
            if (!samePt(segs[segs.length - 1].end, start)) segs.push({ type: 'line', end: start });
            res.push({ kind: 'contour', dark: on(exp), outer: rotateContour({ start, segs }, rot) });
            break;
          }
          case 5: {
            const [exp, nv, cx, cy, dia, rot = 0] = a;
            const outer = polygonContour(cx * s, cy * s, (dia * s) / 2, nv, 0);
            res.push({ kind: 'contour', dark: on(exp), outer: rotateContour(outer, rot) });
            break;
          }
          case 6: {
            // Moiré (deprecated): approximate with the outer ring only.
            const [cx, cy, od] = a;
            res.push({ kind: 'circle', dark: true, center: [cx * s, cy * s], r: (od * s) / 2 });
            this.warn('Moiré macro primitives were approximated.');
            break;
          }
          case 7: {
            const [cx, cy, od, id, gap, rot = 0] = a;
            const c: Pt = [cx * s, cy * s];
            res.push({ kind: 'circle', dark: true, center: c, r: (od * s) / 2 });
            if (id > 0) res.push({ kind: 'circle', dark: false, center: c, r: (id * s) / 2 });
            if (gap > 0) {
              res.push({ kind: 'contour', dark: false, outer: rotateContour(rectContour(c[0], c[1], od * s * 1.02, gap * s, 0), rot) });
              res.push({ kind: 'contour', dark: false, outer: rotateContour(rectContour(c[0], c[1], gap * s, od * s * 1.02, 0), rot) });
            }
            break;
          }
          default:
            this.warn(`Unsupported macro primitive ${code}.`);
        }
      } catch {
        this.warn(`Failed to evaluate macro ${name}.`);
      }
    }
    return res;
  }
}

// ---- geometry helpers ----

export function samePt(a: Pt, b: Pt, eps = 1e-6): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

/** Sweep angle (0..2π] of an arc from `from` to `to` around `c` in the given direction. */
export function arcSweep(from: Pt, to: Pt, c: Pt, cw: boolean): number {
  const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
  const a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
  let d = cw ? a0 - a1 : a1 - a0;
  while (d <= 1e-9) d += 2 * Math.PI;
  while (d > 2 * Math.PI + 1e-9) d -= 2 * Math.PI;
  return d;
}

function rotatePt(p: Pt, deg: number): Pt {
  if (!deg) return p;
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

function mapContour(c: Contour, f: (p: Pt) => Pt): Contour {
  return {
    start: f(c.start),
    segs: c.segs.map((s) => (s.type === 'line' ? { type: 'line', end: f(s.end) } : { type: 'arc', end: f(s.end), center: f(s.center), cw: s.cw })),
  };
}

function rotateContour(c: Contour, deg: number): Contour {
  return deg ? mapContour(c, (p) => rotatePt(p, deg)) : c;
}

export function translatePrim(p: Primitive, dx: number, dy: number): Primitive {
  const t = (q: Pt): Pt => [q[0] + dx, q[1] + dy];
  switch (p.kind) {
    case 'circle':
      return { ...p, center: t(p.center) };
    case 'stroke':
      return { ...p, from: t(p.from), seg: mapContour({ start: [0, 0], segs: [p.seg] }, t).segs[0] };
    case 'contour':
      return { ...p, outer: mapContour(p.outer, t), holes: p.holes?.map((h) => mapContour(h, t)) };
  }
}

export function rectContour(cx: number, cy: number, w: number, h: number, rot: number): Contour {
  const pts: Pt[] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map((p) => rotatePt(p as Pt, rot)).map((p) => [p[0] + cx, p[1] + cy] as Pt);
  return { start: pts[0], segs: [...pts.slice(1), pts[0]].map((end) => ({ type: 'line', end })) };
}

function obroundContour(w: number, h: number): Contour {
  if (w > h) {
    const r = h / 2;
    const x = w / 2 - r;
    return {
      start: [-x, -r],
      segs: [
        { type: 'line', end: [x, -r] },
        { type: 'arc', end: [x, r], center: [x, 0], cw: false },
        { type: 'line', end: [-x, r] },
        { type: 'arc', end: [-x, -r], center: [-x, 0], cw: false },
      ],
    };
  }
  const r = w / 2;
  const y = h / 2 - r;
  return {
    start: [r, -y],
    segs: [
      { type: 'line', end: [r, y] },
      { type: 'arc', end: [-r, y], center: [0, y], cw: false },
      { type: 'line', end: [-r, -y] },
      { type: 'arc', end: [r, -y], center: [0, -y], cw: false },
    ],
  };
}

function polygonContour(cx: number, cy: number, r: number, n: number, rotDeg: number): Contour {
  const pts: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const a = rotDeg * DEG + (2 * Math.PI * k) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return { start: pts[0], segs: [...pts.slice(1), pts[0]].map((end) => ({ type: 'line', end })) };
}

/** Rectangle with square ends from a to b (macro vector line). */
function rectSweepSquare(a: Pt, b: Pt, w: number): Contour {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * (w / 2);
  const ny = (dx / L) * (w / 2);
  const pts: Pt[] = [
    [a[0] + nx, a[1] + ny],
    [a[0] - nx, a[1] - ny],
    [b[0] - nx, b[1] - ny],
    [b[0] + nx, b[1] + ny],
  ];
  return { start: pts[0], segs: [...pts.slice(1), pts[0]].map((end) => ({ type: 'line', end })) };
}

/** Area swept by a w×h rectangle moving from a to b (convex hexagon). */
function rectSweep(a: Pt, b: Pt, w: number, h: number): Contour {
  const hw = w / 2;
  const hh = h / 2;
  const corners: Pt[] = [];
  for (const p of [a, b])
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      corners.push([p[0] + sx * hw, p[1] + sy * hh]);
  const hull = convexHull(corners);
  return { start: hull[0], segs: [...hull.slice(1), hull[0]].map((end) => ({ type: 'line', end })) };
}

function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
