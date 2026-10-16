// Minimal DXF (R12, mm) of a cut pattern: LINE / ARC / CIRCLE entities on COPPER, OUTLINE and HOLES layers.
import { arcAngles, type CutPattern, type PathSeg } from './paths2d';

const n = (v: number) => (+v.toFixed(6)).toString();
const deg = (r: number) => (((r * 180) / Math.PI) % 360 + 360) % 360;

function entities(layer: string, loops: PathSeg[][], out: string[]) {
  for (const loop of loops)
    for (const s of loop) {
      const g = s.type === 'arc' ? arcAngles(s.a, s.m, s.b) : null;
      if (!g) {
        out.push('0', 'LINE', '8', layer, '10', n(s.a[0]), '20', n(s.a[1]), '30', '0', '11', n(s.b[0]), '21', n(s.b[1]), '31', '0');
        continue;
      }
      // DXF arcs run counter-clockwise from start to end angle.
      const a0 = g.sweep > 0 ? g.start : g.start + g.sweep;
      const a1 = a0 + Math.abs(g.sweep);
      out.push('0', 'ARC', '8', layer, '10', n(g.c[0]), '20', n(g.c[1]), '30', '0', '40', n(g.r), '50', n(deg(a0)), '51', n(deg(a1)));
    }
}

export function writeDxf(pattern: CutPattern): string {
  const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC'];
  out.push('0', 'SECTION', '2', 'ENTITIES');
  entities('COPPER', pattern.copper, out);
  entities('OUTLINE', pattern.outline, out);
  entities('HOLES', pattern.slots, out);
  for (const h of pattern.holes) out.push('0', 'CIRCLE', '8', 'HOLES', '10', n(h.c[0]), '20', n(h.c[1]), '30', '0', '40', n(h.r));
  out.push('0', 'ENDSEC', '0', 'EOF', '');
  return out.join('\n');
}
