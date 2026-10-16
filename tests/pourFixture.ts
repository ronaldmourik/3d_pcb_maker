// Generated KiCad-style copper pour: a "fractured" region (clearance holes joined to the outline by
// zero-width slits), pads inside the holes with thermal spokes, and an LPC (clear polarity) knockout.

const N = String.fromCharCode(10);
const c = (v: number) => Math.round(v * 1e6);

export interface PourSpec {
  cols: number;
  rows: number;
  pitch: number;
  padR: number;
  clearance: number;
  segments: number;
}

export const DEFAULT_POUR: PourSpec = { cols: 6, rows: 4, pitch: 8, padR: 1, clearance: 0.6, segments: 32 };

export function pourGerber(spec: PourSpec = DEFAULT_POUR, knockout = true): string {
  const { cols, rows, pitch, padR, clearance, segments } = spec;
  const W = cols * pitch;
  const H = rows * pitch;
  const holeR = padR + clearance;
  const lines: string[] = ['%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', `%ADD10C,${2 * padR}*%`, '%ADD11C,0.5*%', 'G01*'];

  // Fractured region: walk the bottom edge left→right; at each column dive up a slit to each hole in that
  // column (holes are visited bottom to top, then back down the same slit).
  const pts: [number, number][] = [[0, 0]];
  for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) * pitch;
    pts.push([x, 0]);
    const ys = Array.from({ length: rows }, (_, j) => (j + 0.5) * pitch);
    // Up: around each hole clockwise, starting/ending at its bottom point.
    for (const y of ys) {
      pts.push([x, y - holeR]);
      for (let k = 1; k <= segments; k++) {
        const a = -Math.PI / 2 - (2 * Math.PI * k) / segments; // clockwise
        pts.push([x + holeR * Math.cos(a), y + holeR * Math.sin(a)]);
      }
    }
    // Back down the slit.
    for (const y of [...ys].reverse()) pts.push([x, y - holeR]);
    pts.push([x, 0]);
  }
  pts.push([W, 0], [W, H], [0, H], [0, 0]);
  lines.push('G36*', `X${c(pts[0][0])}Y${c(pts[0][1])}D02*`);
  for (const [x, y] of pts.slice(1)) lines.push(`X${c(x)}Y${c(y)}D01*`);
  lines.push('G37*');

  // Pads with four thermal spokes each.
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const x = (i + 0.5) * pitch;
      const y = (j + 0.5) * pitch;
      lines.push('D10*', `X${c(x)}Y${c(y)}D03*`, 'D11*');
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        lines.push(`X${c(x)}Y${c(y)}D02*`, `X${c(x + dx * (holeR + 0.3))}Y${c(y + dy * (holeR + 0.3))}D01*`);
    }

  // A knockout window in clear polarity (as other EDA tools emit), then a pad inside it.
  if (knockout) {
    lines.push('%LPC*%', 'G36*', `X${c(1)}Y${c(H - 3)}D02*`, `X${c(4)}Y${c(H - 3)}D01*`, `X${c(4)}Y${c(H - 1)}D01*`, `X${c(1)}Y${c(H - 1)}D01*`, `X${c(1)}Y${c(H - 3)}D01*`, 'G37*');
    lines.push('%LPD*%', 'D11*', `X${c(2.5)}Y${c(H - 2)}D03*`);
  }
  lines.push('M02*');
  return lines.join(N);
}

/** Expected copper area of the pour (holes, pads, spokes, knockout) for checking. */
export function pourArea(spec: PourSpec = DEFAULT_POUR, knockout = true): number {
  const { cols, rows, pitch, padR, clearance, segments } = spec;
  const holeR = padR + clearance;
  const polyArea = (r: number) => 0.5 * segments * r * r * Math.sin((2 * Math.PI) / segments);
  const n = cols * rows;
  // Spokes: 0.5 wide from the pad edge to the hole edge (+0.3 into the pour, already copper), 4 per pad.
  // Hole polygon is inscribed, so use the polygon's apothem for the gap the spoke bridges.
  const apothem = holeR * Math.cos(Math.PI / segments);
  const spoke = 4 * 0.5 * (apothem - Math.sqrt(padR * padR - 0.25 * 0.25));
  let a = cols * pitch * rows * pitch - n * polyArea(holeR) + n * (Math.PI * padR * padR + spoke);
  if (knockout) a -= 3 * 2 - Math.PI * 0.25 * 0.25;
  return a;
}
