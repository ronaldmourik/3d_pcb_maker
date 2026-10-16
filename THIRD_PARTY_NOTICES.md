# Third-party software

The PCB Maker source code is MIT licensed (see `LICENSE`). The built web app bundles the
following third-party packages, which keep their own licenses.

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| [replicad](https://github.com/sgenoud/replicad) | 1.1.0 | MIT | B-rep modelling API |
| [replicad-opencascadejs](https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs) | 1.1.0 | LGPL-2.1-only | OpenCascade (WebAssembly) geometry kernel |
| [online-3d-viewer](https://github.com/kovacsv/Online3DViewer) | 0.18.0 | MIT | STEP preview |
| [occt-import-js](https://github.com/kovacsv/occt-import-js) | 0.0.22 | LGPL-2.1 | STEP import for the preview (OpenCascade, WebAssembly) |
| [three.js](https://github.com/mrdoob/three.js) | 0.176.0 | MIT | Rendering (via the viewer), section plane |
| [React](https://github.com/facebook/react) | 19 | MIT | User interface |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Zip input, 3MF and zip output |

## OpenCascade (LGPL-2.1)

`replicad-opencascadejs` and `occt-import-js` are WebAssembly builds of
[Open CASCADE Technology](https://dev.opencascade.org/), licensed under the GNU Lesser General
Public License version 2.1 with the Open CASCADE exception. They are shipped unmodified as
separate files (`assets/replicad_single-*.wasm`, `occt/occt-import-js.wasm`) that the app loads at
runtime, so they can be replaced with other builds. The license texts are included in the built
site under `occt/license.occt.txt`, `occt/license.occt-import-js.txt` and
`occt/license.replicad-opencascadejs.txt`, and the sources are
available from the projects linked above.
