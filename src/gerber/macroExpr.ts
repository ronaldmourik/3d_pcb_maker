// Evaluates Gerber aperture macro arithmetic: numbers, $n variables, + - x / and parentheses.

export function evalMacroExpr(expr: string, vars: Map<number, number>): number {
  const src = expr.replace(/\s+/g, '');
  let i = 0;

  const parseExpr = (): number => {
    let v = parseTerm();
    while (src[i] === '+' || src[i] === '-') {
      const op = src[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (src[i] === 'x' || src[i] === 'X' || src[i] === '/') {
      const op = src[i++];
      const r = parseFactor();
      v = op === '/' ? v / r : v * r;
    }
    return v;
  };
  const parseFactor = (): number => {
    const c = src[i];
    if (c === '+') {
      i++;
      return parseFactor();
    }
    if (c === '-') {
      i++;
      return -parseFactor();
    }
    if (c === '(') {
      i++;
      const v = parseExpr();
      if (src[i] === ')') i++;
      return v;
    }
    if (c === '$') {
      i++;
      const m = /^\d+/.exec(src.slice(i));
      if (!m) throw new Error('bad variable');
      i += m[0].length;
      return vars.get(+m[0]) ?? 0;
    }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (!m) throw new Error(`bad macro expression "${expr}"`);
    i += m[0].length;
    return parseFloat(m[0]);
  };

  if (!src) return 0;
  return parseExpr();
}
