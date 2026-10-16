import type { PreviewCategory } from '../geometry/output';
import type { SectionView } from './Viewer';

interface Props {
  available: PreviewCategory[];
  hidden: PreviewCategory[];
  onHidden: (h: PreviewCategory[]) => void;
  overlay: boolean;
  onOverlay: (on: boolean) => void;
  section: SectionView | null;
  onSection: (s: SectionView | null) => void;
}

const LABELS: Record<PreviewCategory, string> = {
  board: 'Board',
  copper: 'Copper',
  stamp: 'Stamps',
  dowel: 'Dowels',
  issue: 'Markers',
  overlay: 'Overlay',
};

/** Viewer controls: body visibility, Gerber overlay and a section plane. */
export function ViewBar({ available, hidden, onHidden, overlay, onOverlay, section, onSection }: Props) {
  const toggle = (c: PreviewCategory) => onHidden(hidden.includes(c) ? hidden.filter((x) => x !== c) : [...hidden, c]);
  return (
    <div className="view-bar">
      <span className="view-label">Show</span>
      {available
        .filter((c) => c !== 'overlay')
        .map((c) => (
          <label key={c} className="check">
            <input type="checkbox" checked={!hidden.includes(c)} onChange={() => toggle(c)} />
            <span>{LABELS[c]}</span>
          </label>
        ))}
      <label className="check" title="Thin green outline of the original Gerber copper on top of the parts">
        <input type="checkbox" checked={overlay} onChange={(e) => onOverlay(e.target.checked)} />
        <span>Gerber overlay</span>
      </label>
      <span className="view-label">Section</span>
      <select value={section?.axis ?? ''} onChange={(e) => onSection(e.target.value ? { axis: e.target.value as 'x' | 'y', t: section?.t ?? 0.5 } : null)}>
        <option value="">Off</option>
        <option value="x">X</option>
        <option value="y">Y</option>
      </select>
      {section && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={section.t}
          onChange={(e) => onSection({ ...section, t: parseFloat(e.target.value) })}
        />
      )}
    </div>
  );
}
