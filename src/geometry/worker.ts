/// <reference lib="webworker" />
// Geometry worker: owns the OpenCascade instance and the last built B-rep.
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import { buildModel, disposeBuild, type BuildResult } from './brep';
import { GeometryCache } from './cache';
import { exportParts, previewIssueSpots, previewStep } from './output';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

const ready = (async () => {
  const oc = await (opencascade as unknown as (o: object) => Promise<unknown>)({ locateFile: () => wasmUrl });
  setOC(oc as never);
  post({ type: 'ready' });
})();

let current: BuildResult | null = null;
const cache = new GeometryCache();

const stepBuffer = async (blob: Blob) => blob.arrayBuffer();

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    await ready;
    if (msg.type === 'build') {
      const t0 = performance.now();
      const next = buildModel(msg.input, msg.settings, (m) => post({ type: 'progress', id: msg.id, message: m }), cache);
      if (current) disposeBuild(current);
      current = next;
      cache.trim();
      post({ type: 'progress', id: msg.id, message: 'Writing STEP preview' });
      const step = await stepBuffer(previewStep(current, msg.preview));
      post(
        {
          type: 'built',
          id: msg.id,
          step,
          parts: current.parts.map((p) => ({ id: p.id, label: p.label })),
          warnings: current.warnings,
          doubleSided: current.doubleSided,
          ms: Math.round(performance.now() - t0),
          cacheHits: current.cacheHits,
          issues: previewIssueSpots(current, msg.preview),
        },
        [step],
      );
    } else if (msg.type === 'preview') {
      if (!current) throw new Error('Nothing built yet');
      const step = await stepBuffer(previewStep(current, msg.preview));
      post({ type: 'preview', id: msg.id, step, issues: previewIssueSpots(current, msg.preview) }, [step]);
    } else if (msg.type === 'export') {
      if (!current) throw new Error('Nothing built yet');
      const f = await exportParts(current, msg.part, msg.format, msg.tolerance, msg.angularTolerance);
      const data = f.data.slice().buffer as ArrayBuffer;
      post({ type: 'file', id: msg.id, name: f.name, data }, [data]);
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
