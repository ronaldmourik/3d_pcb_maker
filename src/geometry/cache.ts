// Worker-level memo for expensive geometry, keyed by input hash + the settings each stage depends on.
import type { AnyShape } from 'replicad';

/* eslint-disable @typescript-eslint/no-explicit-any */

export class GeometryCache {
  private map = new Map<string, unknown>();
  private inputHash: string | null = null;
  hits = 0;
  misses = 0;

  constructor(private readonly maxEntries = 80) {}

  /** Switch to a new input; everything cached for another input is freed. */
  scope(inputHash: string) {
    if (inputHash !== this.inputHash) {
      this.clear();
      this.inputHash = inputHash;
    }
    this.hits = 0;
    this.misses = 0;
  }

  /** Plain memo. Values are shared: callers must not consume or delete them. */
  get<T>(key: string, make: () => T): T {
    if (this.map.has(key)) {
      const v = this.map.get(key) as T;
      this.map.delete(key); // refresh LRU position
      this.map.set(key, v);
      this.hits++;
      return v;
    }
    this.misses++;
    const v = make();
    this.map.set(key, v);
    return v;
  }

  /** Memo for replicad shapes: hands out clones because replicad operations consume their input. */
  shape<T extends AnyShape | null>(key: string, make: () => T): T {
    const v = this.get(key, make);
    return (v ? (v as AnyShape).clone() : v) as T;
  }

  /** Drop least recently used entries; call between builds so nothing in use gets freed. */
  trim() {
    while (this.map.size > this.maxEntries) {
      const [k, v] = this.map.entries().next().value as [string, unknown];
      this.map.delete(k);
      dispose(v);
    }
  }

  clear() {
    for (const v of this.map.values()) dispose(v);
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/** Free OpenCascade objects held in a cached value (shapes, raw TopoDS, or small records of them). */
export function dispose(v: unknown, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 2) return;
  const o = v as any;
  if (typeof o.delete === 'function') {
    try {
      o.delete();
    } catch {
      /* already deleted */
    }
    return;
  }
  if (Array.isArray(o)) for (const x of o) dispose(x, depth + 1);
  else for (const x of Object.values(o)) dispose(x, depth + 1);
}

/** FNV-1a hash of a JSON-serialisable value. */
export function hashValue(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${s.length}`;
}
