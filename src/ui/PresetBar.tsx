import { useState } from 'react';
import type { Preset } from '../state/persist';

interface Props {
  presets: Preset[];
  onUse: (name: string) => void;
  onSave: (name: string) => boolean;
  onDelete: (name: string) => void;
}

/** Load a preset into the draft settings, save the current draft as a preset, or delete one. */
export function PresetBar({ presets, onUse, onSave, onDelete }: Props) {
  const [selected, setSelected] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const current = presets.find((p) => p.name === selected);
  return (
    <div className="preset-bar">
      {naming === null ? (
        <>
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              if (e.target.value) onUse(e.target.value);
            }}
          >
            <option value="">Presets…</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.builtIn ? '' : ' (mine)'}
              </option>
            ))}
          </select>
          <button title="Save the current settings as a preset" onClick={() => setNaming(current && !current.builtIn ? current.name : '')}>
            Save…
          </button>
          {current && !current.builtIn && (
            <button
              title="Delete this preset"
              onClick={() => {
                onDelete(current.name);
                setSelected('');
              }}
            >
              Delete
            </button>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (onSave(naming)) {
              setSelected(naming.trim());
              setNaming(null);
            }
          }}
        >
          <input autoFocus placeholder="Preset name" value={naming} onChange={(e) => setNaming(e.target.value)} />
          <button type="submit" className="primary" disabled={!naming.trim() || presets.some((p) => p.builtIn && p.name === naming.trim())}>
            Save
          </button>
          <button type="button" onClick={() => setNaming(null)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
