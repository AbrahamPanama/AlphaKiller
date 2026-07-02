# AlphaKiller

Current version: **0.1 beta 2** (`0.1.0-beta.2`).

AlphaKiller is an Electron image editor for cleaning transparent-pixel artifacts:
anti-aliased edges, matte halos, and hidden edge RGB around transparent pixels.
It is built for artwork and production files that need clean alpha before PNG,
JPEG, TIFF, PDF, or SVG export, white-ink printing, compositing, or texture use.

## Current MVP

- PNG/JPEG/WebP/TIFF drag-and-drop or file-picker import.
- AI background removal with BRIA API RMBG-2.0, a Fast local RMBG-1.4 path,
  a WebGPU-only Quality BEN2 path, and a restore-original safety affordance.
- Canvas preview with checker, black, white, gray, and custom backgrounds.
- Before, after, split, alpha mask, and difference views.
- Mouse wheel zoom, drag-to-pan, fit/100% zoom controls, and draggable
  before/after split handle.
- Delete Pen tool with variable brush size for manually removing unwanted
  pixels.
- Toolbar trim command that crops transparent padding from the current cleaned
  alpha.
- Defringe and Edge Finishing controls, including hard alpha cutoff and Rim
  Color modes: Off, Auto, and Solid.
- Source metadata, DPI, and pixel inspection.
- PNG, flattened JPEG, transparent TIFF, transparent PDF, or vector contour SVG
  export through Electron's native save dialog.

## Edge Finishing and Rim Color

Color Bleed has been removed as a separate tool because it duplicated the edge
fill behavior now handled by Edge Finishing. Use Rim Color in Edge Finishing
instead:

- **Off**: apply the alpha cutoff without changing edge RGB values.
- **Auto**: fill the rim from nearby visible artwork colors so print edges carry
  matching ink instead of a white, black, or transparent-pixel halo.
- **Solid**: fill the rim with a chosen swatch, useful for deliberate keylines or
  single-color production edges.

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

AlphaKiller does not scale images during cleanup. Exported PNG, JPEG, TIFF, PDF,
and SVG files therefore keep the current pixel dimensions. When the imported file contains
print-resolution metadata, AlphaKiller preserves that DPI on export:

- PNG `pHYs` metadata is read and written back on PNG export.
- JPEG JFIF/EXIF resolution metadata is read and written back as JFIF density
  on JPEG export. JPEG does not support transparency, so transparent pixels are
  flattened onto the selected solid preview background, or white when the
  checker preview is active.
- TIFF X/Y resolution metadata is read and written back on TIFF export.
- Transparent TIFF export uses RGBA with straight alpha.
- PDF export embeds the cleaned bitmap with a soft alpha mask at the current
  working DPI, including DPI changes from Super Scale. If Vector Contour is
  enabled, the contour is added as vector stroke data on top of the bitmap. If
  the source has no DPI metadata, PDF export uses a 300 DPI fallback page size.
- SVG export writes the current vector contour, generated from the cleaned
  preview alpha after all active filters and pen edits.
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

The batch file installs dependencies, builds Windows NSIS installers for both
`x64` and `ia32` 32-bit x86, then launches the installer that matches the
current machine. This is the recommended Windows path because the installed app
launches directly instead of unpacking itself on every run like a portable EXE.
If Node.js is missing, the batch file can install Node.js LTS through `winget`.

Build a macOS DMG:

```bash
npm run dist:mac
```

The default macOS build targets Apple Silicon (`arm64`). Windows compatibility
is handled separately by `npm run dist:win`, which produces both `x64` and
`ia32` 32-bit x86 installers. Portable Windows executables are still available
with `npm run dist:win:portable` for troubleshooting or no-install scenarios.

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
npm run diagnose:pdf
npm run benchmark:bg-remove
```

`diagnose:bg-remove` launches Electron, loads a generated PNG, runs the Remove
Background toolbar flow, verifies the Restore Original affordance, and then
restores the image. The first run may take longer while model assets are
downloaded and cached.

`diagnose:pdf` writes a real PDF export smoke file under `.tmp/` and verifies
that the output includes a PDF header and alpha soft mask.

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
