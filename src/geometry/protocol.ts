import type { BoardInput } from '../gerber/types';
import type { Settings } from '../state/settings';
import type { PartId } from './brep';
import type { ExportFormat, PreviewOptions } from './output';

export type WorkerRequest =
  | { type: 'build'; id: number; input: BoardInput; settings: Settings; preview: PreviewOptions }
  | { type: 'preview'; id: number; preview: PreviewOptions }
  | { type: 'export'; id: number; part: PartId | 'all'; format: ExportFormat; tolerance: number; angularTolerance: number };

export interface PartInfo {
  id: PartId;
  label: string;
}

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: number; message: string }
  | { type: 'error'; id: number; message: string }
  | { type: 'built'; id: number; step: ArrayBuffer; parts: PartInfo[]; warnings: string[]; doubleSided: boolean; ms: number }
  | { type: 'preview'; id: number; step: ArrayBuffer }
  | { type: 'file'; id: number; name: string; data: ArrayBuffer };
