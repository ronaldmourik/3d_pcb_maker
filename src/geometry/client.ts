// Promise-based wrapper around the geometry worker. Cancelling restarts the worker.
import type { WorkerRequest, WorkerResponse } from './protocol';

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; onProgress?: (m: string) => void };

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export class GeometryClient {
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyListeners: (() => void)[] = [];
  ready = false;

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.ready = false;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'ready') {
        this.ready = true;
        this.readyListeners.forEach((l) => l());
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.message);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Geometry worker crashed'));
      this.pending.clear();
    };
  }

  onReady(cb: () => void) {
    if (this.ready) cb();
    else this.readyListeners.push(cb);
  }

  request<T extends WorkerResponse>(req: DistributiveOmit<WorkerRequest, 'id'>, onProgress?: (m: string) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: WorkerResponse) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  /** Abort all running work (terminates the worker; the cached model is lost). */
  cancel() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Cancelled'));
    this.pending.clear();
    this.spawn();
  }
}
