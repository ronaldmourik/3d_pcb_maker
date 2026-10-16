// Rough resistance estimate for conductive-filament traces, per connected copper area (net).
import type { Primitive, Pt } from '../gerber/types';
import { pointInPolygon } from '../gerber/geom2d';
import { arcSweep } from '../gerber/gerber';
import type { PathSeg } from '../export/paths2d';
import { loopArea } from './paths';

export interface NetEstimate {
  /** A point of the net, for locating it. */
  at: Pt;
  /** Total length of the traces (strokes) in this net, mm. */
  length: number;
  /** Narrowest trace, mm. */
  minWidth: number;
  /** Sum of the trace resistances (worst case: all in series), ohm. */
  resistance: number;
}

/**
 * @param islands boundary loops per copper area (outer + holes), oriented as from `faceLoops`
 * @param resistivity filament volume resistivity in Ω·cm
 * @param thickness printed trace thickness in mm
 */
export function estimateNets(prims: Primitive[], islands: PathSeg[][][], resistivity: number, thickness: number, widthOffset: number): NetEstimate[] {
  const rhoMm = resistivity * 10; // Ω·cm → Ω·mm
  const polys = islands.map((loops) => loops.map(loopPoints));
  const nets = islands.map(() => ({ length: 0, minWidth: Infinity, resistance: 0, at: null as Pt | null }));
  for (const p of prims) {
    if (!p.dark || p.kind !== 'stroke') continue;
    const w = p.width + 2 * widthOffset;
    if (w <= 0) continue;
    const { length, mid } = strokeGeometry(p);
    if (length <= 1e-9) continue;
    const idx = polys.findIndex((loops) => loops.some((l) => loopArea2(l) > 0 && pointInPolygon(mid, l)) && !loops.some((l) => loopArea2(l) < 0 && pointInPolygon(mid, l)));
    if (idx < 0) continue;
    const n = nets[idx];
    n.length += length;
    n.minWidth = Math.min(n.minWidth, w);
    n.resistance += (rhoMm * length) / (w * thickness);
    n.at ??= mid;
  }
  return nets.filter((n) => n.length > 0).map((n) => ({ at: n.at!, length: n.length, minWidth: n.minWidth, resistance: n.resistance }));
}

function loopPoints(loop: PathSeg[]): Pt[] {
  const pts: Pt[] = [];
  for (const s of loop) {
    pts.push(s.a);
    if (s.type === 'arc') pts.push(s.m);
  }
  return pts;
}

function loopArea2(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

function strokeGeometry(p: Extract<Primitive, { kind: 'stroke' }>): { length: number; mid: Pt } {
  if (p.seg.type === 'line') {
    const [x0, y0] = p.from;
    const [x1, y1] = p.seg.end;
    return { length: Math.hypot(x1 - x0, y1 - y0), mid: [(x0 + x1) / 2, (y0 + y1) / 2] };
  }
  const { center, cw } = p.seg;
  const r = Math.hypot(p.from[0] - center[0], p.from[1] - center[1]);
  const sweep = arcSweep(p.from, p.seg.end, center, cw);
  const a0 = Math.atan2(p.from[1] - center[1], p.from[0] - center[0]);
  const a = a0 + ((cw ? -1 : 1) * sweep) / 2;
  return { length: r * sweep, mid: [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)] };
}

// Re-exported so callers don't need two imports for the same loop helper.
export { loopArea };
