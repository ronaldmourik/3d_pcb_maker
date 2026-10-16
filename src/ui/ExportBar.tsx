import { useEffect, useState } from 'react';
import type { PartInfo } from '../geometry/protocol';
import type { PartId } from '../geometry/brep';
import type { ExportFormat } from '../geometry/output';

interface Props {
  parts: PartInfo[];
  busy: boolean;
  onExport: (part: PartId | 'all', format: ExportFormat) => void;
}

export function ExportBar({ parts, busy, onExport }: Props) {
  const [part, setPart] = useState<PartId | 'all'>('all');
  const [format, setFormat] = useState<ExportFormat>('step');
  useEffect(() => {
    if (part !== 'all' && !parts.some((p) => p.id === part)) setPart(parts.length === 1 ? parts[0].id : 'all');
  }, [parts, part]);
  return (
    <div className="export-bar">
      <select value={part} onChange={(e) => setPart(e.target.value as PartId | 'all')} disabled={!parts.length}>
        {parts.length > 1 && <option value="all">All parts (zip)</option>}
        {parts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
        <option value="step">STEP</option>
        <option value="stl">STL</option>
        <option value="3mf">3MF</option>
      </select>
      <button className="primary" disabled={!parts.length || busy} onClick={() => onExport(parts.length === 1 ? parts[0].id : part, format)}>
        Download
      </button>
    </div>
  );
}
