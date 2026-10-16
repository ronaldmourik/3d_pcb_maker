// STEP preview using Online3DViewer: it loads the generated STEP file itself.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react';
import * as OV from 'online-3d-viewer';
import { Plane, Vector3 } from 'three';
import type { PreviewCategory } from '../geometry/output';

export interface SectionView {
  axis: 'x' | 'y';
  /** 0..1 across the model. */
  t: number;
}

interface Props {
  step: ArrayBuffer | null;
  /** Changes when the camera should be re-fitted (new layout / new board). */
  fitKey: string;
  busy: boolean;
  busyText?: string;
  /** Zoom to a point (preview coordinates); `n` changes per request. */
  focus?: { at: [number, number, number]; n: number } | null;
  hidden?: PreviewCategory[];
  section?: SectionView | null;
}

interface LoadJob {
  step: ArrayBuffer;
  fitKey: string;
}

export function Viewer({ step, fitKey, busy, busyText, focus, hidden = [], section = null }: Props) {
  const viewRef = useRef({ hidden, section });
  viewRef.current = { hidden, section };
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<OV.EmbeddedViewer | null>(null);
  const fitKeyRef = useRef(fitKey);
  fitKeyRef.current = fitKey;
  const lastFitKey = useRef<string | null>(null);
  const fitPending = useRef(false);
  const loading = useRef(false);
  const queued = useRef<LoadJob | null>(null);

  // o3dv cannot handle overlapping loads, so they are serialized here.
  const start = (job: LoadJob) => {
    const v = viewer.current;
    if (!v) return;
    if (loading.current) {
      queued.current = job;
      return;
    }
    loading.current = true;
    const keep = lastFitKey.current === job.fitKey && !!v.model;
    v.parameters.camera = keep ? v.GetViewer().GetCamera() : undefined;
    fitPending.current = !keep;
    lastFitKey.current = job.fitKey;
    v.LoadModelFromFileList([new File([job.step], 'preview.step')]);
  };
  const finished = () => {
    loading.current = false;
    const next = queued.current;
    queued.current = null;
    if (next) start(next);
  };

  useEffect(() => {
    if (!host.current) return;
    // Own container per viewer instance so a remount never leaves a stale canvas behind.
    const el = document.createElement('div');
    el.className = 'viewer-instance';
    host.current.appendChild(el);
    const v = new OV.EmbeddedViewer(el, {
      backgroundColor: new OV.RGBAColor(236, 240, 245, 255),
      defaultColor: new OV.RGBColor(200, 200, 200),
      edgeSettings: new OV.EdgeSettings(true, new OV.RGBColor(40, 40, 40), 20),
      onModelLoaded: () => {
        if (fitPending.current) {
          fitPending.current = false;
          fitTopView(v);
        }
        applyView(v, viewRef.current.hidden, viewRef.current.section);
        finished();
      },
      onModelLoadFailed: finished,
    });
    viewer.current = v;
    const ro = new ResizeObserver(() => v.Resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      v.Destroy();
      el.remove();
      viewer.current = null;
      lastFitKey.current = null;
      loading.current = false;
      queued.current = null;
    };
  }, []);

  useEffect(() => {
    if (step) start({ step, fitKey: fitKeyRef.current });
  }, [step]);

  useEffect(() => {
    const v = viewer.current;
    if (v?.model) applyView(v, hidden, section);
  }, [hidden.join(), section?.axis, section?.t]);

  useEffect(() => {
    const v = viewer.current;
    if (!v || !focus || !v.model) return;
    const [x, y, z] = focus.at;
    const viewerObj = v.GetViewer();
    // Look down at the spot from slightly in front, close enough to see a trace.
    const up = z >= 0 ? 1 : -1;
    viewerObj.SetCamera(new OV.Camera(new OV.Coord3D(x, y - 6, z + up * 14), new OV.Coord3D(x, y, z), new OV.Coord3D(0, 0, up), 45));
    viewerObj.Render();
  }, [focus]);

  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={host} />
      {!step && !busy && (
        <div className="viewer-empty">
          <p>Upload Gerber + drill files to preview the 3D-printable board.</p>
        </div>
      )}
      {busy && (
        <div className="viewer-busy">
          <div className="spinner" />
          <span>{busyText ?? 'Working…'}</span>
        </div>
      )}
    </div>
  );
}

/** Z-up three-quarter view from the front, fitted to the model. */
function fitTopView(v: OV.EmbeddedViewer) {
  const viewer = v.GetViewer();
  const sphere = viewer.GetBoundingSphere(() => true);
  if (!sphere) return;
  const c = sphere.center;
  viewer.SetUpVector(OV.Direction.Z, false);
  viewer.SetCamera(new OV.Camera(new OV.Coord3D(c.x, c.y - 1.2, c.z + 2), new OV.Coord3D(c.x, c.y, c.z), new OV.Coord3D(0, 0, 1), 45));
  viewer.FitSphereToWindow(sphere, false);
}

/** Category tag from the STEP body name ("category|name"), as written by previewShapes. */
function categoryOf(userData: any): string | null {
  const inst = userData?.originalMeshInstance;
  for (const n of [inst?.node?.GetName?.(), inst?.mesh?.GetName?.()]) {
    if (typeof n === 'string' && n.includes('|')) return n.split('|')[0];
  }
  return null;
}

/** Body visibility and the section (clip) plane. */
function applyView(v: OV.EmbeddedViewer, hidden: PreviewCategory[], section: SectionView | null) {
  const viewer = v.GetViewer() as any;
  viewer.SetMeshesVisibility((ud: unknown) => {
    const c = categoryOf(ud);
    return !c || !hidden.includes(c as PreviewCategory);
  });
  const renderer = viewer.renderer;
  if (!renderer) return;
  if (!section) {
    renderer.clippingPlanes = [];
  } else {
    const sphere = viewer.GetBoundingSphere(() => true);
    const c = sphere.center;
    const r = sphere.radius;
    const pos = (section.axis === 'x' ? c.x : c.y) + (section.t * 2 - 1) * r;
    // Keep the part with smaller coordinates; look into the cut from the open side.
    const normal = section.axis === 'x' ? new Vector3(-1, 0, 0) : new Vector3(0, -1, 0);
    renderer.clippingPlanes = [new Plane(normal, pos)];
  }
  viewer.Render();
}
