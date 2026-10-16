import { useEffect, useState } from 'react';
import type { PartInfo } from '../geometry/protocol';
import { isCutFormat, type ExportFormat, type ExportTarget } from '../geometry/output';

interface Props {
  parts: PartInfo[];
  copperSides: ('top' | 'bottom')[];
  busy: boolean;
  onExport: (target: ExportTarget, format: ExportFormat, mirror: boolean) => void;
}

const SOLID_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'step', label: 'STEP' },
  { value: 'stl', label: 'STL' },
  { value: '3mf', label: '3MF' },
];
const CUT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'svg', label: 'SVG' },
  { value: 'dxf', label: 'DXF' },
];

export function ExportBar({ parts, copperSides, busy, onExport }: Props) {
  const [target, setTarget] = useState<ExportTarget>('all');
  const [format, setFormat] = useState<ExportFormat>('step');
  const [mirror, setMirror] = useState(false);

  const targets: { value: ExportTarget; label: string }[] = [
    ...(parts.length > 1 ? [{ value: 'all' as const, label: 'All parts (zip)' }] : []),
    ...parts.map((p) => ({ value: p.id, label: p.label })),
    ...copperSides.map((s) => ({ value: (s === 'top' ? 'copperTop' : 'copperBottom') as ExportTarget, label: `Copper pattern (${s})` })),
  ];
  const isCopper = target === 'copperTop' || target === 'copperBottom';
  const formats = isCopper ? CUT_FORMATS : SOLID_FORMATS;

  useEffect(() => {
    if (!targets.some((t) => t.value === target) && targets.length) setTarget(targets[0].value);
  }, [targets, target]);
  useEffect(() => {
    if (!formats.some((f) => f.value === format)) setFormat(formats[0].value);
  }, [formats, format]);

  return (
    <div className="export-bar">
      <select value={target} onChange={(e) => setTarget(e.target.value as ExportTarget)} disabled={!targets.length}>
        {targets.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
        {formats.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      {isCutFormat(format) && (
        <label className="check" title="Mirror the pattern, e.g. when the cutter cuts the tape from the back">
          <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
          <span>Mirror</span>
        </label>
      )}
      <button className="primary" disabled={!targets.length || busy} onClick={() => onExport(target, format, mirror)}>
        Download
      </button>
    </div>
  );
}
