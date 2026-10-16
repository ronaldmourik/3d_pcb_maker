// Reads uploaded files (or zips), detects layer types and parses them.
import { unzipSync } from 'fflate';
import type { BoardInput, LayerRole, ParsedLayer } from './types';
import { looksLikeGerber, parseGerber } from './gerber';
import { looksLikeExcellon, parseExcellon } from './drills';

export interface RawFile {
  name: string;
  data: Uint8Array;
}

let nextId = 1;

export async function readUploads(files: File[]): Promise<RawFile[]> {
  const out: RawFile[] = [];
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    out.push(...expandZip({ name: f.name, data }));
  }
  return out;
}

export function expandZip(file: RawFile): RawFile[] {
  if (!/\.zip$/i.test(file.name)) return [file];
  const entries = unzipSync(file.data);
  return Object.entries(entries)
    .filter(([name, data]) => !name.endsWith('/') && data.length > 0 && !/(^|\/)(__MACOSX|\.)/.test(name))
    .flatMap(([name, data]) => expandZip({ name: name.split('/').pop()!, data }));
}

export function parseLayerFile(name: string, text: string): ParsedLayer {
  const id = `L${nextId++}`;
  if (looksLikeExcellon(text) || /\.(drl|xln|exc|drd)$/i.test(name)) {
    const r = parseExcellon(text);
    const role: LayerRole = 'drill';
    return { id, fileName: name, role, detectedRole: role, kind: 'drill', primitives: [], drills: r.drills, warnings: r.warnings, fileFunction: r.fileFunction };
  }
  if (looksLikeGerber(text)) {
    const r = parseGerber(text);
    const role = identifyRole(name, r.fileFunction);
    return { id, fileName: name, role, detectedRole: role, kind: 'gerber', primitives: r.primitives, drills: [], warnings: r.warnings, fileFunction: r.fileFunction };
  }
  return { id, fileName: name, role: 'ignore', detectedRole: 'ignore', kind: 'unknown', primitives: [], drills: [], warnings: ['Not a Gerber or Excellon file.'] };
}

export function parseRawFiles(files: RawFile[]): ParsedLayer[] {
  const dec = new TextDecoder('latin1');
  return files.map((f) => parseLayerFile(f.name, dec.decode(f.data)));
}

export function identifyRole(fileName: string, fileFunction?: string): LayerRole {
  if (fileFunction) {
    const ff = fileFunction.toLowerCase();
    if (ff.startsWith('copper')) {
      if (ff.includes(',top')) return 'top-copper';
      if (ff.includes(',bot')) return 'bottom-copper';
      return 'ignore'; // inner layer
    }
    if (ff.startsWith('profile')) return 'outline';
    if (ff.startsWith('plated') || ff.startsWith('nonplated')) return 'drill';
    return 'ignore';
  }
  const n = fileName.toLowerCase();
  if (/edge[_.\s-]?cuts|\.gko$|\.gm1?$|\.gml$|outline|profile|\.oln$/.test(n)) return 'outline';
  if (/(^|[-_.])f[_.]cu\b|\.gtl$|\.cmp$|top[-_.]?(layer|copper)|copper[-_.]?top/.test(n)) return 'top-copper';
  if (/(^|[-_.])b[_.]cu\b|\.gbl$|\.sol$|bottom[-_.]?(layer|copper)|copper[-_.]?bottom/.test(n)) return 'bottom-copper';
  return 'ignore';
}

/** Common prefix of the uploaded names, used to name exports. */
export function boardName(layers: ParsedLayer[]): string {
  const names = layers.filter((l) => l.role !== 'ignore').map((l) => l.fileName.replace(/\.[^.]+$/, ''));
  if (!names.length) return 'board';
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[-_.\s]+$/, '');
  return prefix || 'board';
}

export function toBoardInput(layers: ParsedLayer[]): BoardInput {
  const pick = (role: LayerRole) => {
    const ls = layers.filter((l) => l.role === role && l.kind === 'gerber');
    return ls.length ? ls.flatMap((l) => l.primitives) : null;
  };
  return {
    name: boardName(layers),
    top: pick('top-copper'),
    bottom: pick('bottom-copper'),
    outline: pick('outline'),
    drills: layers.filter((l) => l.role === 'drill').flatMap((l) => l.drills),
  };
}
