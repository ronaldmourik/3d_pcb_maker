import type { BoardInput } from '../gerber/types';
import type { Settings } from '../state/settings';
import type { PartId } from './brep';
import type { ExportFormat, IssueSpot, PreviewOptions } from './output';

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
  | { type: 'built'; id: number; step: ArrayBuffer; parts: PartInfo[]; warnings: string[]; doubleSided: boolean; ms: number; cacheHits: number; issues: IssueSpot[] }
  | { type: 'preview'; id: number; step: ArrayBuffer; issues: IssueSpot[] }
  | { type: 'file'; id: number; name: string; data: ArrayBuffer };
