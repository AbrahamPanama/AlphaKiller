# AlphaKiller Performance Diagnostics

## Summary

The original lag was caused by full-image processing and full-image canvas uploads happening during interactions that should be lightweight. The worst path was the Delete Pen: every pointer movement committed a new full `ImageData`, which triggered the complete preview pipeline again.

This is solvable. The app needs an interaction pipeline that separates quick canvas manipulation from expensive image processing.

## Confirmed Hotspots

### 1. Delete Pen Reprocesses The Whole Image Per Pointer Event

Before the first remediation pass, `src/App.jsx` called `setOriginalImageData(...)` from the erase stroke path. That state change triggered the full preview effect.

Impact:

- Every brush movement clones the entire image buffer.
- React re-renders.
- `applyProcessing(...)` runs again.
- Stats and canvas rendering are refreshed.

Expected behavior should be: mutate a draft buffer during the stroke, draw a cheap interactive preview, and commit/reprocess once at the end of the stroke.

### 2. Color Bleed Is Very Expensive On Transparent Images

Before remediation, `src/imageProcessing.js` ran color bleed with nested loops:

`iterations * width * height * (2 * radius + 1)^2`

For radius 4 and 4 iterations, that could be up to 324 neighbor checks per pixel. Mostly-transparent images were the worst case because almost every pixel became a bleed candidate.

Local benchmark:

```text
Before fast bleed:
512x512 mostly transparent: 187-225ms
1024x1024 mostly transparent: 711-884ms
2048x2048 mostly transparent: 2879-3444ms

After fast bleed:
512x512 mostly transparent: 4-14ms
1024x1024 mostly transparent: 18-20ms
2048x2048 mostly transparent: 65-72ms
```

Any operation over ~16ms will miss a 60fps frame. Anything over ~100ms feels sticky. Multi-second processing makes the app feel frozen.

### 3. Rendering Uploads Full Image Buffers Too Often

The canvas render path converts `ImageData` into hidden canvases using `putImageData(...)` every render. For large images, that is a full CPU-to-canvas upload for original and processed data.

This should be cached and invalidated only when the underlying image buffer changes.

### 4. Pointer Movement Is Stored In React State

Brush cursor, cursor sample, pan, and split position all update React state directly during high-frequency pointer events.

React can handle some of this, but for canvas editing the hot path should usually use refs plus `requestAnimationFrame`, then commit occasional state updates for UI text.

### 5. Processing Ran On The Main Thread

Preview processing and stats now run in `src/processingWorker.js`. Expensive operations can still take a long time, especially Color Bleed, but they no longer block the renderer's pointer, slider, and paint loop while they run.

## Reproduction Benchmark

Run:

```bash
npm run diagnose:perf
```

This benchmark stresses the same processing pipeline with mostly-transparent synthetic images.

## Feasibility

High. The performance problems are structural but ordinary for early canvas editors. We do not need to abandon Electron, React, or canvas.

## Recommended Plan

## Current Remediation Status

Completed first-pass fixes:

- Delete Pen no longer calls `setOriginalImageData(...)` on every pointer movement.
- Active erase strokes now mutate a draft buffer and visually clear cached canvases during the stroke.
- The source buffer is committed once on pointer-up, so full preview processing happens once per stroke.
- Original and processed `ImageData` canvas uploads are cached by image-data identity.
- The visible canvas is resized only when its physical dimensions change.
- Slider and preset processing now run through a debounced Web Worker scheduler.
- Stale worker results are ignored, and the latest queued settings win.
- Pixel statistics are computed in the worker with the processed preview.
- Mask and Diff preview canvases are cached by input image-data identity.
- The checkerboard background is now a cached canvas pattern.
- Wheel zoom is coalesced through `requestAnimationFrame`.
- The processing worker is terminated and recreated after a worker-level error.
- Drag-over state is latched through drag enter/leave instead of updated on every dragover event.
- Blob object URLs are revoked when replacing a source image and on teardown.

Remaining hotspot:

- Color Bleed and Mask/Diff generation no longer dominate common interactions. The biggest remaining UI-side cleanup is moving pan, split, cursor sampling, and brush hover into refs or a lightweight overlay so React reconciliation is not on the pointer hot path.

### Phase 1: Immediate Responsiveness Fixes

Estimated effort: half day.

- Do not call `setOriginalImageData(...)` on every Delete Pen move.
- Keep active stroke data in refs.
- Commit the erased buffer once on pointer up.
- Draw brush cursor imperatively on the canvas or a lightweight overlay.
- Throttle pan, split, cursor sampling, and brush rendering with `requestAnimationFrame`.
- Recompute expensive preview after stroke end, not during every stroke sample.

Expected result: Delete Pen becomes dramatically smoother.

### Phase 2: Preview Pipeline Cleanup

Estimated effort: 1 day.

- Cache original and processed canvases.
- Avoid `putImageData(...)` unless the image data actually changed.
- Debounce slider changes.
- Use a lower-resolution preview while dragging sliders, then refine after release.
- Split image rendering from UI state rendering.

Expected result: zoom, pan, split, and slider interaction become much smoother on medium assets.

### Phase 3: Worker-Based Processing

Status: first pass complete.

- Move `applyProcessing(...)` into a Web Worker.
- Transfer buffers instead of copying where possible.
- Add cancellation or stale-result ignoring.
- Keep the UI responsive while processing runs.

Expected result: even slow operations no longer freeze the UI. The current implementation copies the source buffer before transfer so the renderer can keep displaying the original image safely.

### Phase 4: Faster Color Bleed Algorithm

Status: first pass complete.

- Replace brute-force neighbor scanning with a boundary-expansion or distance-transform approach.
- Process only transparent/semi-transparent regions that need padding.
- For Delete Pen, recompute only a region around the edited stroke when possible.

Expected result: large transparent images become practical. The current implementation uses a two-pass chamfer-style propagation where `radius * iterations` defines the bleed distance.

## Recommendation

The next high-value step is focused pointer cleanup: move pan, split, cursor sampling, and brush hover into refs or a lightweight overlay so React reconciliation is not on the pointer hot path. Low-resolution slider preview while dragging remains useful for very large images, but the fast bleed pass makes it less urgent than it was.

## Background Removal Notes

Background removal now runs in `src/bgRemoveWorker.js`, separate from the cleanup worker. The current integration uses `@huggingface/transformers` with BRIA RMBG-1.4 as the browser-compatible Stage 1 path, 4-pass TTA by default, tile-and-blend above 2048 px, and mask output composed into the current source alpha before the existing cleanup pipeline runs. The optional "High-quality edges" toggle routes the Stage 1 mask through a ViTMatte trimap refinement path. RMBG-2.0 remains the target model, but the currently tested ONNX/browser conversions fail ORT session creation with a shape-rank mismatch.

Build note: Vite worker output is configured as ES modules in `vite.config.js` because Transformers.js and ONNX Runtime Web code-split inside the worker.

Existing cleanup benchmark after adding the AI dependency:

```text
512x512 mostly transparent: 4.2-14.6ms
1024x1024 mostly transparent: 20.2-21.7ms
2048x2048 mostly transparent: 84.4-107.7ms
```

End-to-end Electron smoke:

```text
npm run diagnose:bg-remove
Background removal smoke passed in 11.1s
```

The smoke command loads a generated PNG through the same hidden file input users trigger from the Open Image button, clicks Remove Background, waits for Restore Original, and restores the image. The first background-removal run downloads model assets from the Hugging Face CDN and caches them locally, so timing depends on model cache state, network, GPU availability, and source content.

Authenticated smoke runs can use a Hugging Face read token supplied through `ALPHAKILLER_HF_TOKEN`, `HF_TOKEN`, or `HF_ACCESS_TOKEN` in the Electron process. The token is forwarded to `src/bgRemoveWorker.js` and applied only to Hugging Face model fetches. The current RMBG-1.4 Stage 1 path is public, so the token is optional by default.

To verify model access before running the full Electron smoke test:

```text
npm run diagnose:hf
HF_MODEL_ID=briaai/RMBG-2.0 HF_TOKEN=your_hugging_face_read_token npm run diagnose:hf
```

Size benchmark harness:

```text
npm run benchmark:bg-remove
```

The benchmark command runs the same Electron flow for generated 512², 1024², and 2048² inputs. It is intentionally end-to-end rather than a worker-only microbenchmark so it catches model loading, WebGPU selection, worker protocol, source replacement, and Restore Original regressions together.
