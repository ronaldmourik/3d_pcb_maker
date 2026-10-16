// STEP preview using Online3DViewer: it loads the generated STEP file itself.
import { useEffect, useRef } from 'react';
import * as OV from 'online-3d-viewer';

interface Props {
  step: ArrayBuffer | null;
  /** Changes when the camera should be re-fitted (new layout / new board). */
  fitKey: string;
  busy: boolean;
  busyText?: string;
}

interface LoadJob {
  step: ArrayBuffer;
  fitKey: string;
}

export function Viewer({ step, fitKey, busy, busyText }: Props) {
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
