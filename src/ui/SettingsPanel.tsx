import type { ReactNode } from 'react';
import type { Settings } from '../state/settings';

interface Props {
  hasSilk: boolean;
  draft: Settings;
  onChange: (s: Settings) => void;
  hasTop: boolean;
  hasBottom: boolean;
  hasOutline: boolean;
  dirty: boolean;
  canApply: boolean;
  onApply: () => void;
  onReset: () => void;
}

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export function SettingsPanel({ hasSilk, draft, onChange, hasTop, hasBottom, hasOutline, dirty, canApply, onApply, onReset }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...draft, [k]: v });
  const num = (k: NumKey, label: string, opts: { step?: number; min?: number; max?: number; unit?: string; hint?: string } = {}) => (
    <label className="field" title={opts.hint}>
      <span>{label}</span>
      <span className="input-unit">
        <input
          type="number"
          value={draft[k]}
          step={opts.step ?? 0.05}
          min={opts.min}
          max={opts.max}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) set(k, v);
          }}
        />
        {opts.unit !== '' && <em>{opts.unit ?? 'mm'}</em>}
      </span>
    </label>
  );
  const bool = (k: BoolKey, label: string, hint?: string) => (
    <label className="check" title={hint}>
      <input type="checkbox" checked={draft[k]} onChange={(e) => set(k, e.target.checked)} />
      <span>{label}</span>
    </label>
  );
  const both = hasTop && hasBottom;
  const sides = both ? draft.sides : hasTop ? 'top' : 'bottom';
  const doubleSided = both && draft.sides === 'both';
  const recessed = draft.mode === 'recessed';
  const conductive = draft.mode === 'conductive';
  const groove = draft.mode === 'groove';
  const flat = recessed || groove;

  return (
    <div className="settings">
      <Section title="Copper traces">
        <div className="segmented">
          {(['recessed', 'raised', 'groove', 'conductive'] as const).map((m) => (
            <button key={m} className={draft.mode === m ? 'active' : ''} onClick={() => set('mode', m)}>
              {m === 'recessed' ? 'Recessed (sand off)' : m === 'raised' ? 'Raised (cut out)' : m === 'groove' ? 'Cut groove (stamp)' : 'Conductive filament'}
            </button>
          ))}
        </div>
        <p className="hint">
          {recessed
            ? 'Traces are channels. Lay the tape over them, press it in, then sand the top surface.'
            : groove
              ? 'Flat board with a groove around each trace. Stick the tape over it and press the stamp: its ridge pushes the tape into the groove and tears it at the trace edge. Peel off the rest.'
              : conductive
              ? 'Traces are printed in conductive filament as a second material. No tape needed.'
              : 'Traces stand proud. Lay the tape over them and cut it along the trace edges.'}
        </p>
        {groove ? (
          <>
            {num('grooveWidth', 'Groove width', { step: 0.05, min: 0.2, hint: 'Measured outward from the trace edge. The stamp ridge is this minus twice the clearance.' })}
            {num('grooveDepth', 'Groove depth', { step: 0.05, min: 0.1, hint: 'Deep enough for the pressed tape to tear at the trace edge.' })}
          </>
        ) : recessed ? (
          num('traceDepth', 'Channel depth', { min: 0.05 })
        ) : (
          num('traceHeight', conductive ? 'Trace thickness' : 'Trace height', { min: 0.05 })
        )}
        {conductive && (
          <>
            {bool('conductiveEmbed', 'Embed flush in the board', 'On: traces fill pockets (one two-material print). Off: traces stand on top.')}
            {num('conductiveResistivity', 'Filament resistivity', { step: 1, min: 0.01, unit: 'Ω·cm', hint: 'Volume resistivity from the filament datasheet (conductive PLA ≈ 15 Ω·cm).' })}
            {num('conductiveMinWidth', 'Min trace width', { step: 0.1, min: 0.2, hint: 'Narrower traces are reported by the printability check.' })}
          </>
        )}
        {!(conductive && draft.conductiveEmbed) && !groove && num('channelChamfer', 'Edge chamfer', {
          step: 0.05,
          min: 0,
          hint: recessed
            ? '45° chamfer on the top edges of the channels, so the tape bends in without tearing. 0 = sharp edges.'
            : '45° bevel on the top edges of the raised traces: a clean line to cut along, and the tape wraps without tearing. 0 = sharp edges.',
        })}
        {num('copperOffset', 'Copper grow / shrink', { step: 0.05, hint: 'Positive widens all traces and pads, negative narrows them.' })}
        <label className="field">
          <span>Sides</span>
          <select value={sides} disabled={!both} onChange={(e) => set('sides', e.target.value as Settings['sides'])}>
            {hasTop && <option value="top">Top only</option>}
            {hasBottom && <option value="bottom">Bottom only</option>}
            {both && <option value="both">Both (two glued halves)</option>}
          </select>
        </label>
      </Section>

      <Section title="Board">
        {num('boardThickness', doubleSided ? 'Total thickness (glued)' : 'Thickness', { min: 0.4 })}
        <label className="field">
          <span>Outline</span>
          <select value={draft.outlineSource} onChange={(e) => set('outlineSource', e.target.value as Settings['outlineSource'])}>
            <option value="edge-cuts" disabled={!hasOutline}>
              Edge.Cuts layer
            </option>
            <option value="bounding-box">Bounding box</option>
          </select>
        </label>
        {(draft.outlineSource === 'bounding-box' || !hasOutline) && num('margin', 'Box margin', { step: 0.5, min: 0 })}
        {bool('holes', 'Drill holes')}
        {draft.holes && (
          <>
            {num('holeOffset', 'Hole diameter offset', { step: 0.05, hint: 'Added to every drill diameter to compensate print shrinkage.' })}
            {num('minHoleDiameter', 'Skip holes smaller than', { step: 0.1, min: 0, hint: 'e.g. 0.5 to leave vias closed.' })}
          </>
        )}
      </Section>

      {doubleSided && (
        <Section title="Double-sided halves">
          <p className="hint">Each half is {(draft.boardThickness / 2).toFixed(2)} mm and printed copper-side up. Glue the flat faces together.</p>
          {bool('alignmentDowels', 'Alignment dowels')}
          {draft.alignmentDowels && (
            <>
              {num('dowelCount', 'Dowel count', { step: 1, min: 1, max: 8, unit: '' })}
              {num('dowelDiameter', 'Dowel diameter', { step: 0.1, min: 1 })}
              {num('dowelDepth', 'Socket depth per half', { step: 0.1, min: 0.3 })}
              {num('dowelClearance', 'Socket clearance', { step: 0.05, min: 0 })}
              {num('dowelEdgeMargin', 'Keep-out margin', { step: 0.5, min: 0 })}
            </>
          )}
        </Section>
      )}

      {hasSilk && (
        <Section title="Silkscreen">
          <label className="field">
            <span>Marks</span>
            <select value={draft.silkMode} onChange={(e) => set('silkMode', e.target.value as Settings['silkMode'])}>
              <option value="off">Off</option>
              <option value="engrave">Engraved</option>
              <option value="emboss" disabled={flat}>
                Embossed{flat ? ' (raised mode only)' : ''}
              </option>
            </select>
          </label>
          {draft.silkMode !== 'off' && (
            <>
              {num('silkDepth', draft.silkMode === 'emboss' ? 'Height' : 'Depth', { step: 0.05, min: 0.1 })}
              {num('silkMinWidth', 'Min line width', { step: 0.05, min: 0.1, hint: 'Thinner silkscreen lines (text) are widened to this.' })}
              {num('silkClearance', 'Clearance to copper', { step: 0.05, min: 0 })}
              {bool(
                'silkSeparate',
                'Separate filament',
                draft.silkMode === 'emboss' && !flat
                  ? 'Print the marks as their own body on the board, in a second filament (multi-material 3MF).'
                  : 'Fill the engraving flush with a second filament (multi-material 3MF).',
              )}
              {draft.silkSeparate && (
                <label className="field" title="Preview colour, also written to the 3MF material.">
                  <span>Filament colour</span>
                  <input type="color" value={draft.silkColor} onChange={(e) => set('silkColor', e.target.value)} />
                </label>
              )}
            </>
          )}
        </Section>
      )}

      {!conductive && <Section title="Press stamp">
        {bool(
          'stampEnabled',
          recessed ? 'Rib stamp (presses tape into channels)' : groove ? 'Ridge stamp (tears tape into the grooves)' : 'Pocket stamp (shears tape at trace edges)',
        )}
        {draft.stampEnabled && (
          <>
            {num('stampThickness', 'Plate thickness', { min: 0.8 })}
            {num('stampClearance', 'Clearance per side', { step: 0.02, min: 0 })}
            {num('tapeThickness', 'Copper tape thickness', { step: 0.01, min: 0 })}
            {num('stampFeatureOverride', recessed ? 'Rib height (0 = auto)' : groove ? 'Ridge height (0 = groove depth)' : 'Pocket depth (0 = auto)', { step: 0.05, min: 0 })}
            {!flat && bool('cuttingRidge', 'Cutting ridge around pockets')}
            {!flat && draft.cuttingRidge && (
              <>
                {num('ridgeWidth', 'Ridge width', { step: 0.05, min: 0.1 })}
                {num('ridgeHeight', 'Ridge height', { step: 0.05, min: 0.1 })}
              </>
            )}
            {bool('alignmentPins', 'Alignment pins in large holes')}
            {draft.alignmentPins && (
              <>
                {num('pinMinHoleDiameter', 'Use holes from', { step: 0.1, min: 0.5 })}
                {num('pinClearance', 'Pin clearance', { step: 0.05, min: 0 })}
                {num('pinLength', 'Pin length', { step: 0.5, min: 0.5 })}
              </>
            )}
          </>
        )}
      </Section>

      }
      <Section title="Printer">
        {bool('printCheck', 'Printability check', 'Warn about traces, pads, gaps and holes the nozzle cannot print.')}
        {draft.printCheck && (
          <>
            {num('nozzleDiameter', 'Nozzle diameter', { step: 0.05, min: 0.1, hint: 'Features narrower than 2× the nozzle are reported.' })}
            {num('minGap', 'Min gap between copper', { step: 0.05, min: 0, hint: 'Walls/gaps between separate copper areas.' })}
          </>
        )}
      </Section>

      <Section title="Export quality">
        {num('meshTolerance', 'STL/3MF tolerance', { step: 0.005, min: 0.001 })}
        {num('angularTolerance', 'Angular tolerance', { step: 0.05, min: 0.01, unit: 'rad' })}
        {bool('mergeBodies', 'Merge copper into board', 'Off: raised copper is a separate body/part (multi-material 3MF).')}
      </Section>

      <div className="apply-bar">
        <button className="primary" disabled={!canApply || !dirty} onClick={onApply}>
          Apply
        </button>
        <button disabled={!dirty} onClick={onReset}>
          Revert
        </button>
        {dirty && <span className="badge">Unapplied changes</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
