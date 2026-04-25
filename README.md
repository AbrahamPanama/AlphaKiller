# AlphaKiller

AlphaKiller is an Electron image editor for cleaning transparent pixel artifacts: anti-aliased edges, matte halos, and hidden RGB bleed around transparent pixels.

## Development

Install dependencies:

```bash
npm install
```

Run the Electron app in development:

```bash
npm run dev
```

Build the renderer:

```bash
npm run build
```

Run diagnostics:

```bash
npm run diagnose:perf
npm run diagnose:hf
npm run diagnose:bg-remove
npm run benchmark:bg-remove
```

`diagnose:bg-remove` launches Electron, loads a generated PNG, runs the Remove Background toolbar flow, verifies the Restore Original affordance, and then restores the image. The first run may take longer while RMBG model assets are downloaded and cached. AlphaKiller currently uses the Transformers.js-compatible BRIA RMBG-1.4 path while RMBG-2.0's ONNX/browser path is blocked by ORT session-shape errors; a Hugging Face token is optional unless you switch back to the gated upstream RMBG-2.0 repository:

```bash
HF_TOKEN=your_hugging_face_read_token npm run diagnose:bg-remove
```

For development, AlphaKiller reads `ALPHAKILLER_HF_TOKEN`, `HF_TOKEN`, or `HF_ACCESS_TOKEN` from the Electron process and passes it only to the background-removal worker when present. Browser-only previews can use `localStorage.setItem("alphakiller:hf-token", "your_hugging_face_read_token")`.

If the Hugging Face page says access is granted but AlphaKiller still reports a restricted model, first check the token:

```bash
HF_MODEL_ID=briaai/RMBG-2.0 HF_TOKEN=your_hugging_face_read_token npm run diagnose:hf
```

The Vite browser preview at `http://127.0.0.1:5173/` cannot see Electron environment variables. Use the localStorage key above for browser preview testing, or run the Electron app with `HF_TOKEN` set.

## Current MVP

- PNG/WebP/TIFF drag-and-drop or file picker import.
- AI background removal with BRIA RMBG, optional high-quality edge refinement, and a restore-original safety affordance.
- Canvas preview with checker, black, white, gray, and custom backgrounds.
- Before, after, split, alpha mask, and difference views.
- Mouse wheel zoom, drag-to-pan, fit/100% zoom controls, and draggable before/after split handle.
- Delete Pen tool with variable brush size for manually removing unwanted pixels.
- Defringe, color bleed, alpha threshold, and alpha hardening controls.
- Source metadata and pixel inspection.
- PNG export through Electron's native save dialog.

## Background Removal Validation

Use the "Remove Background" toolbar button with:

- PNG artwork with hard edges.
- A person or product photo.
- Hair or fine edge detail.
- Semi-transparent glass or translucent material.
- A flat/single-color image with no clear foreground.

The first background-removal run downloads Hugging Face model assets and caches them locally. Background removal is powered by `@huggingface/transformers` and BRIA RMBG. RMBG-2.0 remains the target quality path, but the browser integration currently uses RMBG-1.4 until the RMBG-2.0 ONNX/ORT shape issue is resolved. Do not commit Hugging Face tokens to this repository.
