# AlphaKiller

Current version: **0.1 beta** (`0.1.0-beta.0`).

AlphaKiller is an Electron image editor for cleaning transparent-pixel artifacts:
anti-aliased edges, matte halos, and hidden RGB bleed around transparent pixels.
It is built for artwork and production files that need clean alpha before PNG
or TIFF export, white-ink printing, compositing, or texture use.

## Current MVP

- PNG/WebP/TIFF drag-and-drop or file-picker import.
- AI background removal with BRIA API RMBG-2.0, a Fast local RMBG-1.4 path,
  a WebGPU-only Quality BEN2 path, and a restore-original safety affordance.
- Canvas preview with checker, black, white, gray, and custom backgrounds.
- Before, after, split, alpha mask, and difference views.
- Mouse wheel zoom, drag-to-pan, fit/100% zoom controls, and draggable
  before/after split handle.
- Delete Pen tool with variable brush size for manually removing unwanted
  pixels.
- Defringe, color bleed, alpha threshold, and alpha hardening controls.
- Source metadata, DPI, and pixel inspection.
- PNG or transparent TIFF export through Electron's native save dialog.

## Repository Layout

```text
electron/   Electron main process and preload bridge
scripts/    Diagnostics, smoke tests, benchmarks, and unit tests
src/        React app, image-processing helpers, and workers
```

The app source is committed as normal project files. ZIP handoffs are not part
of the tracked source tree; large downloadable artifacts should live in GitHub
Releases instead.

## Import and Export Metadata

AlphaKiller does not scale images during cleanup. Exported PNG and TIFF files
therefore keep the current pixel dimensions. When the imported file contains
print-resolution metadata, AlphaKiller preserves that DPI on export:

- PNG `pHYs` metadata is read and written back on PNG export.
- TIFF X/Y resolution metadata is read and written back on TIFF export.
- Transparent TIFF export uses RGBA with straight alpha.
- WebP import preserves pixel dimensions; DPI is only preserved when a source
  format exposes readable resolution metadata.

## Development

Install dependencies from a clean clone:

```bash
npm ci
```

Run the Electron app in development:

```bash
npm run dev
```

Build the renderer:

```bash
npm run build
```

Build and install on Windows:

```bat
install-windows.bat
```

The batch file installs dependencies, builds a Windows portable executable,
copies it to `%LOCALAPPDATA%\Programs\AlphaKiller\AlphaKiller.exe`, and creates
Desktop and Start Menu shortcuts. If Node.js is missing, it can install Node.js
LTS through `winget`.

Build a macOS DMG:

```bash
npm run dist:mac
```

For macOS-specific development and packaging notes, see
[`MACOS_DEV_COMPAT.md`](./MACOS_DEV_COMPAT.md).

Run the core verification suite:

```bash
npm run verify
```

`verify` runs unit tests, a production renderer build, the image-processing
performance diagnostic, and the Hugging Face access probe.

## Diagnostics

Run individual diagnostics when working on a narrow area:

```bash
npm test
npm run diagnose:perf
npm run diagnose:hf
npm run diagnose:bg-remove
npm run diagnose:rmbg2:api
npm run benchmark:bg-remove
```

`diagnose:bg-remove` launches Electron, loads a generated PNG, runs the Remove
Background toolbar flow, verifies the Restore Original affordance, and then
restores the image. The first run may take longer while model assets are
downloaded and cached.

## Background Removal Status

AlphaKiller currently ships three Stage 1 background-removal choices:

- **Fast (RMBG-1.4)**: the recommended default. It is currently the fastest,
  most reliable, and best-looking path for AlphaKiller edge quality. No Hugging
  Face token is required.
- **Second Best (BEN2)**: the free/commercial-safe local fallback. It uses
  `onnx-community/BEN2-ONNX` and requires WebGPU in AlphaKiller because the CPU
  path is too slow for the app watchdog.
- **Experimental (BRIA RMBG-2.0)**: a hosted comparison provider. It runs
  through Electron IPC, uploads the normalized PNG to BRIA, and applies the
  returned alpha matte to AlphaKiller's cleanup pipeline. Current artwork-edge
  quality is inconsistent compared with RMBG-1.4. The Settings panel includes a
  "Preserve existing alpha for BRIA" checkbox; turn it off when you want RMBG-2.0
  to rebuild messy source transparency instead of multiplying through existing
  partial alpha.

The local/browser `briaai/RMBG-2.0` and BiRefNet_HR paths remain future quality
targets because their browser/ONNX paths are blocked by ORT runtime issues in
this Electron integration. The hosted BRIA API path avoids those local ONNX
constraints. The high-quality edge-refinement toggle is currently disabled
because the tested ViTMatte repositories do not ship browser-ready ONNX assets.

To use the hosted RMBG-2.0 provider:

```bash
BRIA_API_TOKEN=your_bria_api_token npm run dev
BRIA_API_TOKEN=your_bria_api_token npm run diagnose:rmbg2:api
BRIA_API_TOKEN=your_bria_api_token BRIA_PRESERVE_ALPHA=false npm run diagnose:rmbg2:api
```

The Settings panel can store a local BRIA API token override for development.
For cleaner production hygiene, prefer launching Electron with `BRIA_API_TOKEN`
instead. Do not put BRIA API tokens in source, screenshots, or renderer logs.

If you need to probe a different Hugging Face model:

```bash
HF_MODEL_ID=briaai/RMBG-2.0 HF_TOKEN=your_hugging_face_read_token npm run diagnose:hf
```

For development, AlphaKiller reads `ALPHAKILLER_HF_TOKEN`, `HF_TOKEN`, or
`HF_ACCESS_TOKEN` from the Electron process and passes it only to the
background-removal worker when present. Browser-only previews at
`http://127.0.0.1:5173/` cannot see Electron environment variables and can use:

```js
localStorage.setItem("alphakiller:hf-token", "your_hugging_face_read_token");
```

The `localStorage` token path is for development preview only. Do not commit
tokens or screenshots containing tokens.

## Background Removal Validation

Use the "Remove Background" toolbar button with:

- PNG artwork with hard edges.
- A person or product photo.
- Hair or fine edge detail.
- Semi-transparent glass or translucent material.
- A flat/single-color image with no clear foreground.

The first local background-removal run downloads Hugging Face model assets and
caches them locally. The BRIA API provider does not download local weights; it
uploads the normalized PNG to BRIA and downloads the returned PNG result. See
`THIRD_PARTY_LICENSES.md` before packaging or redistributing builds.

To benchmark a specific background-removal model:

```bash
npm run benchmark:bg-remove -- --model rmbg-1.4
npm run benchmark:bg-remove -- --model ben2
```

## Security and Licensing

- Application source is licensed under `LICENSE`.
- Dependency and model notices live in `THIRD_PARTY_LICENSES.md`.
- Electron and token-handling notes live in `SECURITY.md`.
- Current model weights are downloaded on demand and are not committed to this
  repository.

## Known Limitations

- Electron packaging/signing is not configured yet.
- BRIA API mode requires Electron and `BRIA_API_TOKEN`.
- BEN2 Quality mode requires WebGPU. CPU-only users should use Fast mode.
- BiRefNet_HR and full BiRefNet remain deferred pending browser-compatible ONNX
  and memory/runtime fixes.
- There is no full undo stack beyond the one-click Restore Original affordance
  after background removal.
- CI runs lightweight diagnostics only. Full background-removal smoke tests can
  be slow because they download and execute model assets.
