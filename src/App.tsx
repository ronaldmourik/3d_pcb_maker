import { FileDrop } from './ui/FileDrop';
import { LayerList } from './ui/LayerList';
import { SettingsPanel } from './ui/SettingsPanel';
import { Viewer } from './ui/Viewer';
import { ExportBar } from './ui/ExportBar';
import { useBoardBuild } from './state/useBoardBuild';
import { IssueList } from './ui/IssueList';
import { PresetBar } from './ui/PresetBar';
import { ViewBar } from './ui/ViewBar';
import type { PreviewCategory } from './geometry/output';

export default function App() {
  const b = useBoardBuild();
  const { preview } = b;
  const problems = b.issues.filter((i) => i.level !== 'info');
  const info = b.issues.filter((i) => i.level === 'info');
  const ids = b.parts.map((p) => p.id);
  const available: PreviewCategory[] = [
    'board',
    ...(b.draft.mode !== 'recessed' ? (['copper'] as const) : []),
    ...(ids.some((i) => i.startsWith('stamp')) ? (['stamp'] as const) : []),
    ...(ids.includes('dowels') ? (['dowel'] as const) : []),
    ...(problems.length ? (['issue'] as const) : []),
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>PCB Maker</h1>
          <p>3D-printable copper-tape circuit boards from Gerber files</p>
        </header>
        <FileDrop onFiles={b.addFiles} />
        <LayerList layers={b.layers} onRole={b.setRole} onRemove={b.removeLayer} />
        {b.layers.length > 0 && !b.hasTop && !b.hasBottom && <p className="error">Assign at least one copper layer.</p>}
        <PresetBar presets={b.presets} onUse={b.loadPreset} onSave={b.savePreset} onDelete={b.deletePreset} />
        <SettingsPanel
          hasSilk={b.hasSilk}
          draft={b.draft}
          onChange={b.setDraft}
          hasTop={b.hasTop}
          hasBottom={b.hasBottom}
          hasOutline={b.hasOutline}
          dirty={b.dirty}
          canApply={b.canApply}
          onApply={b.apply}
          onReset={b.revert}
        />
      </aside>
      <main>
        <div className="toolbar">
          <div className="segmented small">
            <button className={preview.layout === 'print' ? 'active' : ''} onClick={() => b.changePreview({ ...preview, layout: 'print' })}>
              Print layout
            </button>
            <button className={preview.layout === 'assembled' ? 'active' : ''} onClick={() => b.changePreview({ ...preview, layout: 'assembled' })}>
              Assembled
            </button>
          </div>
          {b.hasStamps && (
            <label className="check">
              <input type="checkbox" checked={preview.showStamps} onChange={(e) => b.changePreview({ ...preview, showStamps: e.target.checked })} />
              <span>Show stamps</span>
            </label>
          )}
          <span className="status">
            {!b.engineReady ? 'Loading geometry engine…' : b.buildMs !== null && !b.busy ? `Built in ${(b.buildMs / 1000).toFixed(1)} s${b.cacheHits ? ` · reused ${b.cacheHits} cached step${b.cacheHits === 1 ? "" : "s"}` : ""}` : ''}
          </span>
          {b.busy && b.building && <button onClick={b.cancel}>Cancel</button>}
          <ExportBar parts={b.parts} copperSides={b.copperSides} busy={!!b.busy} onExport={b.exportPart} />
        </div>
        {b.step && (
          <ViewBar
            available={available}
            hidden={b.hidden}
            onHidden={b.setHidden}
            overlay={!!preview.overlay}
            onOverlay={(on) => b.changePreview({ ...preview, overlay: on })}
            section={b.section}
            onSection={b.setSection}
          />
        )}
        {b.error && <div className="banner error">{b.error}</div>}
        {(b.warnings.length > 0 || problems.length > 0) && (
          <div className="banner warn">
            {b.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
            <IssueList issues={problems} onFocus={b.focusIssue} />
          </div>
        )}
        {info.length > 0 && (
          <div className="banner info">
            <IssueList issues={info} onFocus={b.focusIssue} plain />
          </div>
        )}
        <Viewer step={b.step} fitKey={b.fitKey} focus={b.focus} hidden={b.hidden} section={b.section} busy={!!b.busy || (!b.engineReady && b.layers.length > 0)} busyText={b.busy ?? 'Loading geometry engine…'} />
      </main>
    </div>
  );
}
