// 1:1 SVG (mm) of a cut pattern, for vinyl cutters (Cricut, Silhouette) or Inkscape.
import { arcAngles, mapPattern, patternBounds, type CutPattern, type PathSeg, type P2 } from './paths2d';

const MARGIN = 2;
const n = (v: number) => +v.toFixed(4);

function loopPath(loop: PathSeg[]): string {
  if (!loop.length) return '';
  const parts: string[] = [];
  let cur: P2 | null = null;
  for (const s of loop) {
    if (!cur || Math.hypot(cur[0] - s.a[0], cur[1] - s.a[1]) > 1e-6) parts.push(`M${n(s.a[0])} ${n(s.a[1])}`);
    cur = s.b;
    if (s.type === 'line') {
      parts.push(`L${n(s.b[0])} ${n(s.b[1])}`);
      continue;
    }
    const g = arcAngles(s.a, s.m, s.b);
    if (!g) {
      parts.push(`L${n(s.b[0])} ${n(s.b[1])}`);
      continue;
    }
    const large = Math.abs(g.sweep) > Math.PI ? 1 : 0;
    const sweep = g.sweep > 0 ? 1 : 0;
    parts.push(`A${n(g.r)} ${n(g.r)} 0 ${large} ${sweep} ${n(s.b[0])} ${n(s.b[1])}`);
  }
  return parts.join(' ') + ' Z';
}

export function writeSvg(pattern: CutPattern, title: string): string {
  const b = patternBounds(pattern);
  // SVG has y pointing down: flip and move the pattern to the origin.
  const f = (q: P2): P2 => [q[0] - b.minX + MARGIN, b.maxY - q[1] + MARGIN];
  const p = mapPattern(pattern, f);
  const w = n(b.maxX - b.minX + 2 * MARGIN);
  const h = n(b.maxY - b.minY + 2 * MARGIN);
  const group = (id: string, color: string, loops: PathSeg[][]) =>
    loops.length
      ? `  <g id="${id}" fill="none" stroke="${color}" stroke-width="0.1">\n${loops.map((l) => `    <path d="${loopPath(l)}"/>`).join('\n')}\n  </g>`
      : '';
  const holeEls = [
    ...p.holes.map((c) => `    <circle cx="${n(c.c[0])}" cy="${n(c.c[1])}" r="${n(c.r)}"/>`),
    ...p.slots.map((l) => `    <path d="${loopPath(l)}"/>`),
  ];
  const holes = holeEls.length ? `  <g id="holes" fill="none" stroke="#2b6cb0" stroke-width="0.1">\n${holeEls.join('\n')}\n  </g>` : '';
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
    `  <title>${title.replace(/[<&]/g, '')}</title>`,
    group('copper', '#c05621', p.copper),
    group('outline', '#718096', p.outline),
    holes,
    `</svg>`,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}
