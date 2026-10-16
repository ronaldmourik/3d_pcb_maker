// Excellon drill file parser (holes and slots, mm output).
import type { Drill, Pt } from './types';

export interface DrillResult {
  drills: Drill[];
  warnings: string[];
  fileFunction?: string;
}

export function looksLikeExcellon(text: string): boolean {
  return /^M48\s*$/m.test(text) || (/^T\d+C[\d.]+/m.test(text) && /^(METRIC|INCH)/m.test(text));
}

export function parseExcellon(text: string): DrillResult {
  const warnings: string[] = [];
  const drills: Drill[] = [];
  const tools = new Map<number, number>();
  let fileFunction: string | undefined;
  let scale = 25.4;
  let unitsSet = false;
  let intDigits = 2;
  let decDigits = 4;
  let digitsSet = false;
  let trailingSuppressed = false; // "LZ": leading zeros kept, trailing suppressed
  let tool: number | null = null;
  let x = 0;
  let y = 0;
  let incremental = false;
  let routeMode = false;
  let toolDown = false;
  let routeStart: Pt | null = null;
  let inHeader = false;

  const setUnits = (metric: boolean, rest: string) => {
    scale = metric ? 1 : 25.4;
    unitsSet = true;
    if (!digitsSet) {
      intDigits = metric ? 3 : 2;
      decDigits = metric ? 3 : 4;
    }
    if (/LZ/.test(rest)) trailingSuppressed = true;
    if (/TZ/.test(rest)) trailingSuppressed = false;
    const fm = /,(0+)\.(0+)/.exec(rest);
    if (fm) {
      intDigits = fm[1].length;
      decDigits = fm[2].length;
      digitsSet = true;
    }
  };

  const num = (v: string): number => {
    if (v.includes('.')) return parseFloat(v) * scale;
    let s = v;
    let neg = false;
    if (s[0] === '+' || s[0] === '-') {
      neg = s[0] === '-';
      s = s.slice(1);
    }
    let val: number;
    if (trailingSuppressed) val = parseInt(s.padEnd(intDigits + decDigits, '0'), 10) / 10 ** decDigits;
    else val = parseInt(s, 10) / 10 ** decDigits;
    return (neg ? -val : val) * scale;
  };

  const readXY = (s: string): Pt | null => {
    const mx = /X([+-]?[\d.]+)/.exec(s);
    const my = /Y([+-]?[\d.]+)/.exec(s);
    if (!mx && !my) return null;
    let nx = mx ? num(mx[1]) : incremental ? 0 : x;
    let ny = my ? num(my[1]) : incremental ? 0 : y;
    if (incremental) {
      nx += x;
      ny += y;
    }
    return [nx, ny];
  };

  const dia = () => (tool !== null ? tools.get(tool) : undefined);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(';')) {
      const ff = /TF\.FileFunction,(.*)$/.exec(line);
      if (ff) fileFunction = ff[1];
      const fmt = /FILE_FORMAT=(\d):(\d)/.exec(line);
      if (fmt) {
        intDigits = +fmt[1];
        decDigits = +fmt[2];
        digitsSet = true;
      }
      continue;
    }
    if (line === 'M48') {
      inHeader = true;
      continue;
    }
    if (line === '%' || line === 'M95') {
      inHeader = false;
      continue;
    }
    const um = /^(METRIC|INCH)(.*)$/.exec(line);
    if (um) {
      setUnits(um[1] === 'METRIC', um[2]);
      continue;
    }
    if (line === 'M71') {
      setUnits(true, '');
      continue;
    }
    if (line === 'M72') {
      setUnits(false, '');
      continue;
    }
    if (line === 'G90') {
      incremental = false;
      continue;
    }
    if (line === 'G91') {
      incremental = true;
      continue;
    }
    if (line === 'G05' || line === 'G81') {
      routeMode = false;
      continue;
    }
    if (line === 'M15') {
      toolDown = true;
      routeStart = [x, y];
      continue;
    }
    if (line === 'M16' || line === 'M17') {
      toolDown = false;
      routeStart = null;
      continue;
    }
    const td = /^T(\d+)(.*)$/.exec(line);
    if (td) {
      const t = +td[1];
      const c = /C([\d.]+)/.exec(td[2]);
      if (c) tools.set(t, parseFloat(c[1]) * (unitsSet ? scale : 25.4));
      if (!c || !inHeader) tool = t === 0 ? null : t;
      continue;
    }
    // Slot: X..Y..G85X..Y..
    const g85 = line.indexOf('G85');
    if (g85 >= 0) {
      const a = readXY(line.slice(0, g85));
      if (a) {
        x = a[0];
        y = a[1];
      }
      const b = readXY(line.slice(g85 + 3));
      const d = dia();
      if (a && b && d) drills.push({ at: a, to: b, diameter: d });
      if (b) {
        x = b[0];
        y = b[1];
      }
      continue;
    }
    if (/^G00/.test(line)) {
      routeMode = true;
      const p = readXY(line);
      if (p) {
        x = p[0];
        y = p[1];
      }
      continue;
    }
    if (/^G0[123]/.test(line)) {
      const p = readXY(line);
      const d = dia();
      if (p && d && routeMode && toolDown) {
        const from = routeStart ?? [x, y];
        if (/^G0[23]/.test(line)) warnings.push('Routed arcs in drill file approximated as straight slots.');
        drills.push({ at: from, to: p, diameter: d });
        routeStart = p;
      }
      if (p) {
        x = p[0];
        y = p[1];
      }
      continue;
    }
    if (/^[XY]/.test(line)) {
      const p = readXY(line);
      if (!p) continue;
      x = p[0];
      y = p[1];
      const d = dia();
      if (d) drills.push({ at: p, diameter: d });
      else warnings.push('Drill hit without a tool diameter ignored.');
    }
  }
  return { drills, warnings: [...new Set(warnings)], fileFunction };
}
