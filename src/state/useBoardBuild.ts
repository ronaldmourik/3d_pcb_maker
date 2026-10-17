// All app state: uploaded layers, draft/applied settings and the geometry worker round-trips.
import { useEffect, useRef, useState } from 'react';
import { GeometryClient } from '../geometry/client';
import type { PartInfo, WorkerResponse } from '../geometry/protocol';
import type { ExportFormat, ExportTarget, IssueSpot, PreviewCategory, PreviewOptions } from '../geometry/output';
import type { SectionView } from '../ui/Viewer';
import { parseRawFiles, readUploads, toBoardInput } from '../gerber/loadFiles';
import type { LayerRole, ParsedLayer } from '../gerber/types';
import { settingsEqual, type Settings } from './settings';
import { applyPreset, BUILT_IN_PRESETS, load, presetValues, save, type Preset } from './persist';

type Built = Extract<WorkerResponse, { type: 'built' }>;

interface Applied {
  settings: Settings;
  layersVersion: number;
}

// One worker for the whole app (StrictMode would otherwise spawn two in development).
const client = new GeometryClient();

const MIME: Record<string, string> = { zip: 'application/zip', '3mf': 'model/3mf', stl: 'model/stl', step: 'model/step', svg: 'image/svg+xml', dxf: 'image/vnd.dxf' };

function download(name: string, data: ArrayBuffer) {
  const ext = name.split('.').pop() ?? '';
  const url = URL.createObjectURL(new Blob([data], { type: MIME[ext] ?? 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function useBoardBuild() {
  const [engineReady, setEngineReady] = useState(false);
  const [layers, setLayers] = useState<ParsedLayer[]>([]);
  const [layersVersion, setLayersVersion] = useState(0);
  const [stored] = useState(() => load());
  const [draft, setDraft] = useState<Settings>(stored.draft);
  const [userPresets, setUserPresets] = useState<Preset[]>(stored.presets);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [preview, setPreview] = useState<PreviewOptions>(stored.preview ?? { layout: 'print', showStamps: true });
  // Viewer-only options (no rebuild): hidden body categories and a section plane.
  const [hidden, setHidden] = useState<PreviewCategory[]>([]);
  const [section, setSection] = useState<SectionView | null>(null);
  const [step, setStep] = useState<ArrayBuffer | null>(null);
  const [parts, setParts] = useState<PartInfo[]>([]);
  const [copperSides, setCopperSides] = useState<('top' | 'bottom')[]>([]);
  const [doubleSided, setDoubleSided] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [issues, setIssues] = useState<IssueSpot[]>([]);
  /** Viewer focus request; `n` changes on every click so the same spot can be focused again. */
  const [focus, setFocus] = useState<{ at: IssueSpot['at']; n: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildMs, setBuildMs] = useState<number | null>(null);
  const [cacheHits, setCacheHits] = useState(0);
  const buildingRef = useRef(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;

  useEffect(() => client.onReady(() => setEngineReady(true)), []);
  // Remember settings, view and presets between visits.
  useEffect(() => save({ draft, preview, presets: userPresets }), [draft, preview, userPresets]);

  const presets = [...BUILT_IN_PRESETS, ...userPresets];
  const loadPreset = (name: string) => {
    const p = presets.find((x) => x.name === name);
    if (p) setDraft((d) => applyPreset(d, p));
  };
  const savePreset = (name: string) => {
    const clean = name.trim();
    if (!clean || BUILT_IN_PRESETS.some((p) => p.name === clean)) return false;
    setUserPresets((ps) => [...ps.filter((p) => p.name !== clean), { name: clean, values: presetValues(draft) }]);
    return true;
  };
  const deletePreset = (name: string) => setUserPresets((ps) => ps.filter((p) => p.name !== name));

  const markBuilding = (b: boolean) => {
    buildingRef.current = b;
    setBuilding(b);
  };

  const hasTop = layers.some((l) => l.role === 'top-copper' && l.primitives.length > 0);
  const hasBottom = layers.some((l) => l.role === 'bottom-copper' && l.primitives.length > 0);
  const hasOutline = layers.some((l) => l.role === 'outline');
  const hasZones = layers.some(
    (l) => (l.role === 'top-copper' || l.role === 'bottom-copper') && l.primitives.some((p) => p.kind === 'contour' && p.zone),
  );
  const hasSilk = layers.some((l) => (l.role === 'silk-top' || l.role === 'silk-bottom') && l.primitives.length > 0);
  const dirty = !applied || !settingsEqual(draft, applied.settings) || applied.layersVersion !== layersVersion;
  const canApply = (hasTop || hasBottom) && engineReady;

  const runBuild = async (ls: ParsedLayer[], settings: Settings, version: number) => {
    if (buildingRef.current) client.cancel(); // drop the running build, the new one supersedes it
    markBuilding(true);
    setApplied({ settings, layersVersion: version });
    setError(null);
    setBusy('Starting build');
    try {
      const res = await client.request<Built>(
        { type: 'build', input: toBoardInput(ls), settings, preview: previewRef.current },
        (m) => setBusy(m),
      );
      setStep(res.step);
      setParts(res.parts);
      setCopperSides(res.copperSides);
      setWarnings(res.warnings);
      setIssues(res.issues);
      setDoubleSided(res.doubleSided);
      setBuildMs(res.ms);
      setCacheHits(res.cacheHits);
      markBuilding(false);
      setBusy(null);
    } catch (e) {
      if ((e as Error).message === 'Cancelled') return;
      markBuilding(false);
      setBusy(null);
      setError((e as Error).message);
    }
  };

  const addFiles = async (files: File[]) => {
    try {
      const parsed = parseRawFiles(await readUploads(files));
      const names = new Set(parsed.map((p) => p.fileName));
      const next = [...layers.filter((l) => !names.has(l.fileName)), ...parsed];
      const version = layersVersion + 1;
      setLayers(next);
      setLayersVersion(version);
      const top = next.some((l) => l.role === 'top-copper');
      const bottom = next.some((l) => l.role === 'bottom-copper');
      const sides: Settings['sides'] = top && bottom ? 'both' : bottom ? 'bottom' : 'top';
      const outlineSource = next.some((l) => l.role === 'outline') ? draft.outlineSource : 'bounding-box';
      const nextDraft: Settings = { ...draft, sides, outlineSource };
      setDraft(nextDraft);
      // First model builds automatically; afterwards changes wait for Apply.
      if (!applied && (top || bottom)) runBuild(next, nextDraft, version);
    } catch (e) {
      setError(`Could not read files: ${(e as Error).message}`);
    }
  };

  const setRole = (id: string, role: LayerRole) => {
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, role } : l)));
    setLayersVersion((v) => v + 1);
  };

  const removeLayer = (id: string) => {
    setLayers((ls) => ls.filter((l) => l.id !== id));
    setLayersVersion((v) => v + 1);
  };

  const apply = () => runBuild(layers, draft, layersVersion);
  const revert = () => applied && setDraft(applied.settings);

  const cancel = () => {
    client.cancel();
    markBuilding(false);
    setBusy(null);
    setStep(null);
    setParts([]);
    setApplied(null);
  };

  const changePreview = async (p: PreviewOptions) => {
    setPreview(p);
    if (!step || buildingRef.current) return;
    setBusy('Updating preview');
    try {
      const res = await client.request<Extract<WorkerResponse, { type: 'preview' }>>({ type: 'preview', preview: p });
      setStep(res.step);
      setIssues(res.issues);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportPart = async (part: ExportTarget, format: ExportFormat, mirror = false) => {
    if (!applied) return;
    setBusy(`Exporting ${format.toUpperCase()}`);
    try {
      const res = await client.request<Extract<WorkerResponse, { type: 'file' }>>({
        type: 'export',
        part,
        format,
        tolerance: applied.settings.meshTolerance,
        angularTolerance: applied.settings.angularTolerance,
        mirror,
      });
      download(res.name, res.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const focusIssue = (i: IssueSpot) => setFocus((f) => ({ at: i.at, n: (f?.n ?? 0) + 1 }));

  const hasStamps = parts.some((p) => p.id.startsWith('stamp'));
  const fitKey = `${applied?.layersVersion ?? 0}:${preview.layout}:${preview.showStamps && hasStamps}:${doubleSided}`;

  return {
    engineReady,
    layers,
    draft,
    setDraft,
    presets,
    loadPreset,
    savePreset,
    deletePreset,
    preview,
    hidden,
    setHidden,
    section,
    setSection,
    step,
    parts,
    copperSides,
    warnings,
    issues,
    focus,
    focusIssue,
    error,
    busy,
    building,
    buildMs,
    cacheHits,
    hasTop,
    hasBottom,
    hasOutline,
    hasSilk,
    hasZones,
    hasStamps,
    dirty,
    canApply,
    fitKey,
    addFiles,
    setRole,
    removeLayer,
    apply,
    revert,
    cancel,
    changePreview,
    exportPart,
  };
}
