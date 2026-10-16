import type { LayerRole, ParsedLayer } from '../gerber/types';

const ROLES: { value: LayerRole; label: string }[] = [
  { value: 'top-copper', label: 'Top copper' },
  { value: 'bottom-copper', label: 'Bottom copper' },
  { value: 'outline', label: 'Board outline' },
  { value: 'drill', label: 'Drill' },
  { value: 'ignore', label: 'Ignore' },
];

interface Props {
  layers: ParsedLayer[];
  onRole: (id: string, role: LayerRole) => void;
  onRemove: (id: string) => void;
}

export function LayerList({ layers, onRole, onRemove }: Props) {
  if (!layers.length) return null;
  const sorted = [...layers].sort((a, b) => Number(a.role === 'ignore') - Number(b.role === 'ignore'));
  return (
    <ul className="layers">
      {sorted.map((l) => (
        <li key={l.id} className={l.role === 'ignore' ? 'ignored' : ''}>
          <div className="layer-row">
            <span className="layer-name" title={l.fileName}>
              {l.fileName}
            </span>
            <select value={l.role} onChange={(e) => onRole(l.id, e.target.value as LayerRole)}>
              {ROLES.filter((r) => (l.kind === 'drill' ? r.value === 'drill' || r.value === 'ignore' : r.value !== 'drill')).map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <button className="icon" title="Remove" onClick={() => onRemove(l.id)}>
              ×
            </button>
          </div>
          <div className="layer-meta">
            {l.kind === 'drill' ? `${l.drills.length} holes` : l.kind === 'gerber' ? `${l.primitives.length} shapes` : 'unrecognised'}
            {l.warnings.length > 0 && <span className="warn" title={l.warnings.join('\n')}> · {l.warnings.length} warning(s)</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
