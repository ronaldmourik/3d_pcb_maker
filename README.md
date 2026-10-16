# PCB Maker

Browser app that turns Gerber + Excellon exports (KiCad or any EDA tool) into 3D-printable boards for copper-tape circuits.

- **Recessed** traces: channels you press tape into and sand flush, or **raised** traces you cut the tape around.
- Traces, pads and regions are merged into one copper shape; drill holes and slots are cut through.
- Optional 45° **channel edge chamfer** for recessed boards, so the tape folds into the channels without tearing. It is built as a cut with one tapered tool per primitive (see `src/geometry/chamfer.ts`) because OpenCascade's edge chamfer fails on tangent pad/trace contacts.
- **Double-sided** boards are generated as two halves (copper-side up, bottom half mirrored) with optional alignment dowels to glue them together.
- Optional **press stamp**: ribs for recessed boards, or pockets with an optional cutting ridge for raised boards, with alignment pins in the larger holes.
- The geometry is a true B-rep built with OpenCascade (replicad). The preview is the generated STEP file shown in Online3DViewer, and downloads are STEP, STL or 3MF, all from the same model.
- Settings only take effect when you click **Apply**.

## Usage

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # parser + geometry tests (OpenCascade runs in Node)
npm run build    # static site in dist/
```

In KiCad, use *File → Fabrication Outputs → Gerbers* (F.Cu, B.Cu, Edge.Cuts) and *Drill Files* (Excellon). Then drop the files or a zip into the app. You can change any layer's role in the file list.

## Structure

| Path | Purpose |
| --- | --- |
| `src/gerber/` | Gerber RS-274X parser (apertures, macros, regions, arcs, step-repeat, polarity), Excellon parser, outline chaining, layer detection |
| `src/geometry/faces.ts` | Exact 2D primitives → OpenCascade faces (arcs stay arcs) |
| `src/geometry/brep.ts` | Board / halves / dowels / stamps as B-rep solids |
| `src/geometry/output.ts` | Preview layout (print / assembled) and STEP / STL / 3MF export |
| `src/geometry/worker.ts` | Web Worker that owns OpenCascade and the last built model |
| `src/ui/` | React UI: upload, layers, settings (draft → apply), viewer, export |

Notes:
- Copper is fused in 2D and extruded once, which is much faster than fusing 3D solids.
- `scripts/copy-occt.mjs` copies occt-import-js into `public/occt/`, and a Vite plugin points Online3DViewer at that copy so the app works offline.
