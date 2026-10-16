import { useEffect, useRef, useState } from 'react';
import { FileDrop } from './ui/FileDrop';
import { LayerList } from './ui/LayerList';
import { SettingsPanel } from './ui/SettingsPanel';
import { Viewer } from './ui/Viewer';
import { ExportBar } from './ui/ExportBar';
import { GeometryClient } from './geometry/client';
import type { PartInfo, WorkerResponse } from './geometry/protocol';
import type { PartId } from './geometry/brep';
import type { ExportFormat, PreviewOptions } from './geometry/output';
import { parseRawFiles, readUploads, toBoardInput } from './gerber/loadFiles';
import type { LayerRole, ParsedLayer } from './gerber/types';
import { defaultSettings, settingsEqual, type Settings } from './state/settings';

type Built = Extract<WorkerResponse, { type: 'built' }>;

interface Applied {
  settings: Settings;
  layersVersion: number;
}

// One worker for the whole app (StrictMode would otherwise spawn two in development).
const client = new GeometryClient();

export default function App() {
  const [engineReady, setEngineReady] = useState(false);
  const [layers, setLayers] = useState<ParsedLayer[]>([]);
  const [layersVersion, setLayersVersion] = useState(0);
  const [draft, setDraft] = useState<Settings>(defaultSettings);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [preview, setPreview] = useState<PreviewOptions>({ layout: 'print', showStamps: true });
  const [step, setStep] = useState<ArrayBuffer | null>(null);
  const [parts, setParts] = useState<PartInfo[]>([]);
  const [doubleSided, setDoubleSided] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [buildMs, setBuildMs] = useState<number | null>(null);
  const building = useRef(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;

  useEffect(() => client.onReady(() => setEngineReady(true)), []);

  const hasTop = layers.some((l) => l.role === 'top-copper' && l.primitives.length > 0);
  const hasBottom = layers.some((l) => l.role === 'bottom-copper' && l.primitives.length > 0);
  const hasOutline = layers.some((l) => l.role === 'outline');
  const dirty = !applied || !settingsEqual(draft, applied.settings) || applied.layersVersion !== layersVersion;
  const canApply = hasTop || hasBottom;

  const runBuild = async (ls: ParsedLayer[], settings: Settings, version: number) => {
    if (building.current) client.cancel(); // drop the running build, the new one supersedes it
    building.current = true;
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
      setWarnings(res.warnings);
      setDoubleSided(res.doubleSided);
      setBuildMs(res.ms);
      building.current = false;
      setBusy(null);
    } catch (e) {
      if ((e as Error).message === 'Cancelled') return;
      building.current = false;
      setBusy(null);
      setError((e as Error).message);
    }
  };

  const onFiles = async (files: File[]) => {
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
      const nextDraft = { ...draft, sides, outlineSource } as Settings;
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

  const changePreview = async (p: PreviewOptions) => {
    setPreview(p);
    if (!step || building.current) return;
    setBusy('Updating preview');
    try {
      const res = await client.request<Extract<WorkerResponse, { type: 'preview' }>>({ type: 'preview', preview: p });
      setStep(res.step);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onExport = async (part: PartId | 'all', format: ExportFormat) => {
    if (!applied) return;
    setBusy(`Exporting ${format.toUpperCase()}`);
    try {
      const res = await client.request<Extract<WorkerResponse, { type: 'file' }>>({
        type: 'export',
        part,
        format,
        tolerance: applied.settings.meshTolerance,
        angularTolerance: applied.settings.angularTolerance,
      });
      const mime = res.name.endsWith('.zip') ? 'application/zip' : res.name.endsWith('.3mf') ? 'model/3mf' : res.name.endsWith('.stl') ? 'model/stl' : 'model/step';
      const url = URL.createObjectURL(new Blob([res.data], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = res.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const hasStamps = parts.some((p) => p.id.startsWith('stamp'));
  const fitKey = `${applied?.layersVersion ?? 0}:${preview.layout}:${preview.showStamps && hasStamps}:${doubleSided}`;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>PCB Maker</h1>
          <p>3D-printable copper-tape circuit boards from Gerber files</p>
        </header>
        <FileDrop onFiles={onFiles} />
        <LayerList layers={layers} onRole={setRole} onRemove={removeLayer} />
        {layers.length > 0 && !canApply && <p className="error">Assign at least one copper layer.</p>}
        <SettingsPanel
          draft={draft}
          onChange={setDraft}
          hasTop={hasTop}
          hasBottom={hasBottom}
          hasOutline={hasOutline}
          dirty={dirty}
          canApply={canApply && engineReady}
          onApply={() => runBuild(layers, draft, layersVersion)}
          onReset={() => applied && setDraft(applied.settings)}
        />
      </aside>
      <main>
        <div className="toolbar">
          <div className="segmented small">
            <button className={preview.layout === 'print' ? 'active' : ''} onClick={() => changePreview({ ...preview, layout: 'print' })}>
              Print layout
            </button>
            <button className={preview.layout === 'assembled' ? 'active' : ''} onClick={() => changePreview({ ...preview, layout: 'assembled' })}>
              Assembled
            </button>
          </div>
          {hasStamps && (
            <label className="check">
              <input type="checkbox" checked={preview.showStamps} onChange={(e) => changePreview({ ...preview, showStamps: e.target.checked })} />
              <span>Show stamps</span>
            </label>
          )}
          <span className="status">
            {!engineReady ? 'Loading geometry engine…' : buildMs !== null && !busy ? `Built in ${(buildMs / 1000).toFixed(1)} s` : ''}
          </span>
          {busy && building.current && (
            <button
              onClick={() => {
                client.cancel();
                building.current = false;
                setBusy(null);
                setStep(null);
                setParts([]);
                setApplied(null);
              }}
            >
              Cancel
            </button>
          )}
          <ExportBar parts={parts} busy={!!busy} onExport={onExport} />
        </div>
        {error && <div className="banner error">{error}</div>}
        {warnings.length > 0 && (
          <div className="banner warn">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        <Viewer step={step} fitKey={fitKey} busy={!!busy || (!engineReady && layers.length > 0)} busyText={busy ?? 'Loading geometry engine…'} />
      </main>
    </div>
  );
}
