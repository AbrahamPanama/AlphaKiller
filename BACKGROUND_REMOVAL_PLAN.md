# AlphaKiller — Background Removal Implementation Plan

> Current implementation note: the shipped worker currently uses
> `briaai/RMBG-1.4` because the planned `briaai/RMBG-2.0` browser/ONNX path is
> blocked by ORT session-shape/runtime failures. Treat this document as the
> quality-target plan; see `README.md` for the runnable implementation state and
> `BIREFNET_HR_PLAN.md` for the next model-investigation track.

## 1. Goal

Add an AI-powered background removal feature to AlphaKiller that integrates cleanly with the existing alpha-cleanup pipeline (defringe, color bleed, alpha threshold, alpha hardening, delete pen). The output of the segmentation step should be a soft alpha mask that the existing tools then refine, positioning AlphaKiller as a "cleanup-aware background remover" rather than a one-shot competitor to remove.bg.

This plan is implementation-ready: file-level changes, message protocols, state additions, error paths, and acceptance criteria are all specified. It is not code.

## 2. Decisions Already Locked In

These came out of the planning conversation and should not be re-litigated during implementation:

- **Project posture:** Non-commercial, open-source. This unlocks the highest-quality models (notably BRIA RMBG-2.0) whose licenses prohibit commercial redistribution but permit research / personal / non-commercial use.
- **Library:** `@huggingface/transformers` (Transformers.js v3+, browser-side, ONNX Runtime Web under the hood). Replaces the earlier `@imgly/background-removal` choice — Transformers.js gives us direct access to the latest checkpoints, dodges the AGPL-3.0 wrapper, and lets us swap models without changing the integration shape.
- **Primary model (Stage 1 — segmentation):** `briaai/RMBG-2.0`. State-of-the-art binary/soft matting trained on a curated 12k-image set; subjectively and on benchmarks materially better than ISNet on hair, fur, transparent objects, and busy backgrounds. License is non-commercial — acceptable given the project posture.
- **Optional Stage 2 — matting refinement:** `hustvl/ViTMatte-base` (Apache 2.0) or `PramaLLC/BEN2`. Takes the Stage 1 output as a trimap and produces a true alpha matte. Opt-in toggle ("High-quality edges"), not run by default.
- **Lighter alternative path (commercial-safe escape hatch):** `ZhengPeng7/BiRefNet_HR` (MIT, trained at 2048²). Used if the project ever needs to be re-licensed for commercial use.
- **Quality maximization:** Native-resolution inference up to 2048²; tile-and-blend above that; 4× Test-Time Augmentation (horizontal flip + 90° rotations) merged via element-wise mean. See §4.3.
- **UX:** A separate "Remove Background" toolbar button + status feedback. Not auto-on-import. Not part of the cleanup ToolSection stack. A single "High-quality edges" toggle in the same control gates Stage 2 (matting refinement).
- **Integration model:** Segmentation output replaces `originalImageData`; the existing cleanup pipeline runs unchanged on the new image. A "Restore Original" affordance preserves user safety without requiring a full undo stack.
- **Threading:** Inference runs in a dedicated Web Worker, separate from `processingWorker.js`, to isolate the heavy model from the per-stroke processing loop.

## 3. Recommended Stack

| Concern | Choice | Notes |
|---|---|---|
| Library | `@huggingface/transformers` (Transformers.js v3+) | Apache 2.0 wrapper; loads ONNX-format models directly from the Hugging Face Hub. Adds ~40–60 lines of pre/post-processing the library otherwise hides, but in exchange we get the latest checkpoints and zero AGPL contamination. |
| Stage 1 model (segmentation) | `briaai/RMBG-2.0` (BiRefNet architecture) | SOTA on DIS5K and curated benchmarks; visibly better than ISNet on hair, fur, mesh, and translucent edges. Non-commercial license — fine for this project. |
| Stage 2 model (optional, opt-in) | `hustvl/ViTMatte-base` *or* `PramaLLC/BEN2` | Trimap-conditioned matting refinement. Takes Stage 1 mask, dilates uncertain band, returns a true alpha matte. Apache 2.0. Adds ~1–3s on WebGPU. |
| Commercial-safe alt (if posture changes) | `ZhengPeng7/BiRefNet_HR` | MIT-licensed BiRefNet variant trained at 2048². Slightly behind RMBG-2.0 on edge quality but free of redistribution concerns. |
| Runtime | ONNX Runtime Web (WASM + WebGPU) | Loaded transitively by Transformers.js. WebGPU is critical — RMBG-2.0 on CPU is uncomfortably slow (~10–15s at 1024²). |
| Storage of model weights | IndexedDB cache (handled by Transformers.js) | First load downloads ~250 MB for RMBG-2.0 fp16, ~110 MB for ViTMatte-base; subsequent app launches are instant. |
| Delivery for V1 | On-demand download from the Hugging Face CDN on first use | Smaller Electron bundle. The cache survives app upgrades. |
| GPU acceleration | WebGPU enabled in Electron via command-line switch | Drops 1024² inference from ~10s (CPU) to ~0.6s (GPU) on RMBG-2.0. |
| Precision | fp16 weights when WebGPU available, quantized int8 fallback for low-end CPU | Transformers.js exposes this via the `dtype` option on the pipeline. |

Why Transformers.js over `@imgly/background-removal`:

1. **Quality ceiling.** imgly's npm package locks us to the ISNet family. RMBG-2.0 sits on the BiRefNet architecture, which is a generation ahead.
2. **Licensing.** The imgly npm package is AGPL-3.0 — viral for distribution. Transformers.js is Apache 2.0; we only need to honor each model's own license.
3. **Optionality.** Adding ViTMatte for opt-in matting refinement is a one-line pipeline call under Transformers.js; under imgly it would require a parallel ONNX integration anyway.
4. **Future-proofing.** New checkpoints (BiRefNet variants, BEN2 successors, future matting models) ship to Hugging Face first. Pinning to imgly's release cadence would slow us down.

Why not OpenCV.js: classical methods (GrabCut, watershed) are interactive-tool territory, not one-shot subject extraction. We may revisit OpenCV later for the manual mask-refinement tool listed in §15.

## 4. Architecture Overview

### 4.1 Pipeline Composition

```
File import
   │
   ▼
originalImageData ─────────────────────────────────┐
   │                                                │
   │  (user clicks Remove Background)               │
   ▼                                                │
bgRemoveWorker — Stage 1 (RMBG-2.0)                 │
   │   • Native-resolution or tiled inference       │
   │   • Optional 4× Test-Time Augmentation         │
   ▼                                                │
Soft alpha mask (uint8 luminance)                   │
   │                                                │
   │  if "High-quality edges" toggle is ON:         │
   ▼                                                │
bgRemoveWorker — Stage 2 (ViTMatte-base)  [opt-in]  │
   │   • Builds trimap from Stage 1 mask            │
   │   • Returns refined alpha matte                │
   ▼                                                │
Final alpha mask                                    │
   │                                                │
   ▼                                                │
Compose: source RGB × source α × mask α             │
   │                                                │
   ▼                                                │
preSegmentationOriginal ◄───────────────────────────┘   (kept for "Restore Original")
originalImageData (REPLACED)
   │
   ▼
processingWorker.js (existing pipeline: defringe → bleed → threshold → harden)
   │
   ▼
processedImageData
   │
   ▼
Canvas render
```

The key insight: nothing in the existing cleanup pipeline needs to change. Background removal slots upstream of `applyProcessing` and produces an `ImageData` that the existing code already knows how to consume.

### 4.2 Worker Topology

Two workers run concurrently:

- **`processingWorker.js`** — existing. Runs the cleanup pipeline. Lifecycle is per-app-session, lazily created. Already wired with job IDs, request IDs, and queue-collapse semantics in `App.jsx:207–304`.
- **`bgRemoveWorker.js`** — new. Runs segmentation. Lazily created on first "Remove Background" click. Holds the model in memory across calls. Same job/request ID pattern.

Keeping them separate matters because:
1. Loading RMBG-2.0 (and optionally ViTMatte) inside `processingWorker.js` would balloon the worker's memory baseline from ~10 MB to ~600–800 MB, which is wasteful when the user only ever clicks the button once.
2. A crash in the segmentation worker should not kill the cleanup pipeline, and vice versa.
3. The two workers have very different cancellation semantics (cleanup wants aggressive coalescing; segmentation wants single-shot completion).

### 4.3 Quality Maximization Pipeline

The single biggest determinant of output quality, after model choice, is **what we feed the model and how we average its predictions.** This subsection is normative — implementation must follow it for the "best quality" promise to land.

**a. Native-resolution inference (≤ 2048²).** RMBG-2.0 was trained at 1024², but BiRefNet-class models generalize well to higher inputs because their decoder is fully convolutional. For images with max-edge ≤ 2048, run inference at native resolution. Skip the library's default downscale-then-upsample path — that's where the imgly version visibly loses edge detail. Memory cost: ~1.5 GB peak at 2048²; acceptable on any machine that runs an Electron app.

**b. Tile-and-blend (> 2048²).** For larger images, split into 1024² or 1536² tiles with a 128 px overlap. Run inference per tile. Blend overlap regions with a cosine window (raised-cosine in both axes) to avoid seam artifacts. Concatenate tile masks back into a full-resolution mask. This is the standard photoreal-pipeline trick; it preserves fine edges that any single-shot downscale would destroy.

**c. Test-Time Augmentation (TTA, 4×).** For each input (or each tile), run inference on:
   - The original
   - Horizontally flipped
   - Rotated 180°
   - Horizontally flipped + rotated 180°

Un-augment each output mask back to original orientation, then average pixel-wise. This costs 4× inference time but consistently lifts edge quality and reduces "missed" thin features (hair strands, fence wires, antennae). It's the cheapest quality lever we have and we should expose it as the default for the "best quality" path.

**Decision matrix for which techniques to apply:**

| Source size | Stage 1 strategy | TTA | Stage 2 (if toggle on) |
|---|---|---|---|
| ≤ 1024² | Native | 4× | ViTMatte at native |
| 1024–2048² | Native | 4× | ViTMatte at native |
| 2048²–4096² | Tile (1536², 128 px overlap) | 4× per tile | ViTMatte per tile |
| > 4096² | Tile (1024², 128 px overlap) | 2× per tile (perf budget) | Skip Stage 2 (memory) |

**d. Stage 2 — Matting refinement (opt-in).** When the "High-quality edges" toggle is on:
   1. Take the Stage 1 mask.
   2. Build a trimap: thresholds at 0.05 → background, ≥ 0.95 → foreground, the band between → unknown. Optionally dilate the unknown band by 8 px to give the matting model room to work.
   3. Feed `(image, trimap)` into `hustvl/ViTMatte-base`. Output is an alpha matte at the same resolution.
   4. Replace the Stage 1 mask with the matting output.

ViTMatte-base produces alpha mattes that are visibly superior to any segmentation-only model on hair, fur, and translucent edges. The cost is ~110 MB extra download and ~1–3s extra inference on WebGPU. Worth it for a quality-first project; gated behind a toggle so users with smaller machines or impatience can skip it.

**e. Determinism.** All operations above are deterministic given identical inputs and seeds. The model itself has no stochastic layers in eval mode. We can rely on byte-for-byte stability across runs for visual regression testing.

## 5. Implementation Phases

Each phase is self-contained and shippable. They can be merged in order without breaking the app at any point.

### Phase 0 — Project prep (≈ 1 hour, low risk)

- Add `@huggingface/transformers` (v3.x or later) to `package.json` dependencies. Transformers.js bundles `onnxruntime-web` transitively; no explicit ORT pin needed.
- Add `enable-features=Vulkan,WebGPU` (or platform-equivalent) command-line switch in `electron/main.js` *before* `app.whenReady()`. Verify with `chrome://gpu` inside the dev window that WebGPU is enabled.
- Verify Vite handles `import.meta.url` worker resolution for the new worker file (it already does, per the existing `processingWorker.js` reference at `App.jsx:212`).
- Configure Transformers.js to allow remote model downloads from the Hugging Face CDN: set `env.allowRemoteModels = true` and `env.useBrowserCache = true` at module load. Confirm Vite does not pre-bundle ONNX runtime WASM (it should be loaded lazily via the worker's URL).
- Add the Hugging Face CDN to the renderer's CSP if/when one is introduced (currently no CSP is set; this is a forward note).

**Acceptance:** `npm run dev` opens the app as today; `navigator.gpu` is truthy in the renderer DevTools console; a smoke import of `@huggingface/transformers` succeeds in a worker without bloating the main bundle.

### Phase 1 — Worker scaffolding (≈ 1 day, medium risk)

Create `src/bgRemoveWorker.js`. Because Transformers.js does not ship a one-call `removeBackground()` for RMBG-2.0, this worker owns ~40–60 lines of pre/post-processing in addition to the pipeline call. The shape mirrors `processingWorker.js`.

**Inputs (postMessage):**
```
{
  id: number,
  buffer: ArrayBuffer,        // RGBA Uint8ClampedArray
  width: number,
  height: number,
  options: {
    tta: boolean,              // default true
    refine: boolean,           // default false (Stage 2 ViTMatte)
    tileThreshold: number      // px above which to tile (default 2048)
  }
}
```

**Outputs (postMessage to main thread):**
```
// Progress
{ id, stage: 'download' | 'warming' | 'infer-stage1' | 'infer-stage2' | 'compose', progress: 0..1 }

// Success
{
  id,
  width,
  height,
  maskBuffer: ArrayBuffer,         // single-channel Uint8 mask, full source resolution
  durationMs: number,
  stagesRun: ['stage1', 'stage2']  // which stages actually ran
}

// Error
{ id, error: string, stage?: string }
```

**Behavior:**
- Lazy-import `@huggingface/transformers` inside the message handler.
- Cache the loaded models in worker scope. Stage 1 (RMBG-2.0) loads on first message; Stage 2 (ViTMatte) loads only when `options.refine === true`.
- Use `pipeline('image-segmentation', 'briaai/RMBG-2.0', { device: 'webgpu', dtype: 'fp16' })` with a CPU+int8 fallback if WebGPU is unavailable.
- Pre-processing for Stage 1: convert RGBA → RGB tensor in `[0,1]`, normalize per the model's preprocessor config (mean `[0.5, 0.5, 0.5]`, std `[1.0, 1.0, 1.0]` per RMBG-2.0's published preprocessor), upload to GPU.
- Run the inference per the strategy table in §4.3 (native / tiled / TTA).
- Post-processing for Stage 1: sigmoid the logits, clamp to `[0,1]`, scale to `[0,255]` Uint8, resize to source resolution if the model output is at training resolution.
- Optional Stage 2: build trimap from Stage 1 mask, run `pipeline('image-matting', 'hustvl/ViTMatte-base')`, replace mask.
- Emit `progress` events at: model download start, download complete, model warming complete, after each TTA pass, after Stage 2 (if run).
- Transfer the mask buffer back to the main thread (zero-copy) using the `transfer` array on `postMessage`.

**Reference snippet (illustrative, do not copy verbatim):**
```
// Inside worker
import { pipeline, env } from '@huggingface/transformers';
env.allowLocalModels = false;

let stage1, stage2;
async function getStage1() {
  stage1 ??= await pipeline(
    'image-segmentation',
    'briaai/RMBG-2.0',
    { device: 'webgpu', dtype: 'fp16' }
  );
  return stage1;
}
```

**Acceptance:** A standalone unit test (or a temporary dev button) can post a synthetic 256×256 buffer to the worker and receive a same-sized mask back, with at least two progress events observed. Toggling `options.tta` produces an output with measurably different mean values (proves TTA is actually running). Toggling `options.refine` triggers a second model download on first use.

### Phase 2 — Mask composition + trimap utilities (≈ half day, low risk)

Add three pure helpers alongside `imageProcessing.js`. All must be DOM-free so they can run in either the main thread or a worker.

**a. `applyMaskToImage(originalImageData, maskBuffer, options) → ImageData`**

- `maskBuffer` is a `Uint8Array` with `width × height` entries (single-channel, `[0,255]`). Not RGBA.
- Same dimensions for input and mask (the worker upsamples to source resolution before posting back).
- For each pixel: `outputAlpha = round((sourceAlpha × maskValue) / 255)`. RGB is preserved exactly.
- Optional `threshold` (default `0`): mask values strictly below this are clamped to `0` before multiplication. Useful for hard-edged subjects after Stage 1.

**b. `buildTrimap(maskBuffer, width, height, options) → Uint8Array`**

Used to feed Stage 2. Walks the Stage 1 mask and produces a 3-state trimap:
- `0` (background) where mask < `bgThresh` (default `0.05 × 255 ≈ 13`).
- `255` (foreground) where mask ≥ `fgThresh` (default `0.95 × 255 ≈ 242`).
- `128` (unknown) otherwise.
- After the threshold pass, dilate the unknown band by `dilateRadius` pixels (default `8`) using a separable max-filter. The dilation is what gives ViTMatte room to "redraw" the edge.

**c. `dilateBand(buffer, width, height, value, radius) → Uint8Array`**

Helper for `buildTrimap`. A separable two-pass (horizontal then vertical) max-filter that grows pixels matching `value`. O(width × height × 2) — fast enough at 2048² to stay in the worker without blocking.

**Acceptance:** Unit tests against a synthetic 8×8 mask produce expected trimap values to the byte; `applyMaskToImage` against a hand-crafted 4×4 image and mask produces expected RGBA to the byte.

### Phase 3 — Worker orchestration in App.jsx (≈ half day, medium risk)

Add a parallel orchestration block to the existing one in `App.jsx:207–304`. Same pattern, different worker:

New refs:
- `bgRemoveWorkerRef`
- `bgRemoveJobIdRef`
- `latestBgRemoveRequestRef`
- `activeBgRemoveJobRef`

New helpers:
- `ensureBgRemoveWorker()`
- `startBgRemoveJob(job)`
- `runBackgroundRemoval()` — public-facing handler the toolbar button calls.

New state:
- `bgRemoveStatus`: `'idle' | 'downloading' | 'warming' | 'inferring' | 'error'`.
- `bgRemoveProgress`: 0–1, used for the progress strip.
- `preSegmentationOriginal`: kept in a ref, not state — it's a snapshot, not a render input.

Cleanup behavior:
- Cancellation = bump `latestBgRemoveRequestRef` and ignore stale results in `onmessage`. Same staleness pattern as the cleanup worker.
- On unmount, terminate the worker.
- On error, terminate and null out `bgRemoveWorkerRef` so the next click re-spawns. (This is also the recommended fix for the existing cleanup worker — see audit item B.4 in the latest review.)

**Acceptance:** Calling `runBackgroundRemoval()` from a temporary debug button replaces `originalImageData` with a transparent-background version of the source, the cleanup pipeline runs, and the canvas re-renders correctly.

### Phase 4 — Toolbar button + Inspector affordances (≈ half day, low risk)

UI additions (no new files, edit `App.jsx` and `styles.css`):

1. **Toolbar button.** Add a `Wand2` or `Scissors`-variant icon button to the existing toolbar, positioned between the existing tool buttons and the comparison-mode segmented control. Disabled when no image is loaded or when `bgRemoveStatus !== 'idle'`. Tooltip: "Remove Background".

2. **Progress strip.** When `bgRemoveStatus !== 'idle'`, show a thin progress bar at the top of the canvas-shell (above the canvas). Stage label rotates with status:
   - `downloading` → "Downloading background-removal model"
   - `warming` → "Preparing model"
   - `inferring` → "Removing background"

3. **"Restore Original" button.** Appears in the left Source panel (under the source thumbnail) only when `preSegmentationOriginal` is non-null. Click → restores `originalImageData` from the snapshot, clears the snapshot, dismisses any segmentation-related toast.

4. **Status bar entry.** When inferring, show "Removing background…" in the status bar. Existing status states are unchanged.

5. **Toast on first-run download.** "First-time download (~120 MB) — this only happens once" — info severity, dismissible.

6. **Toast on error.** Specific messages per failure type (see §10).

**Acceptance:** Button is reachable by keyboard, has a focus state, has a tooltip, and respects the spec's accessibility requirements (§16 of `AlphaKiller_UI_Spec.md`).

### Phase 5 — Restore/undo affordance (≈ 2 hours, low risk)

Already touched in Phase 3 (the `preSegmentationOriginal` ref) and Phase 4 (the Restore button). Phase 5 is the polish:

- Confirmation dialog before destructive overwrites is *not* required for V1 because Restore is one click away.
- Loading a new file via drag-and-drop or file picker should clear `preSegmentationOriginal` (otherwise Restore would put back the wrong image).
- "Restore Original" should also clear any active segmentation toast.

**Acceptance:** Run BG removal, run cleanup adjustments, click Restore, observe the original image and stats return; cleanup settings are *not* reset (intentional — user preferences survive).

### Phase 6 — Error handling polish (≈ half day, low risk)

Categorize errors and route them to specific UX:

| Failure | Detection | UX response |
|---|---|---|
| First-run download fails (offline) | `download` stage error | Toast: "Couldn't download the background removal model. Check your connection and try again." Retry button. |
| WebGPU unavailable | Library reports CPU fallback | No toast; status bar appends "(CPU)" while inferring. |
| Inference times out (>30s) | `setTimeout` watchdog in App.jsx | Toast: "Background removal took too long. Try a smaller image." Terminate worker. |
| Worker crashes mid-run | `worker.onerror` | Toast: "Background removal failed." Terminate worker, null the ref. |
| OOM on very large images | Caught in worker, posted as `error` | Toast: "Image too large for background removal at full resolution." Suggest manual downscale before retry. |
| Model corruption (bad cache) | Library reports invalid model | Toast: "Background removal model is corrupted. Clear cache?" with a button to call `caches.delete` / IndexedDB delete. |

**Acceptance:** Each error path is reachable in dev mode (with network throttling, with a custom worker that throws, etc.) and produces the documented toast.

### Phase 7 — Testing and benchmarks (≈ half day, low risk)

1. Extend `scripts/perf-benchmark.mjs` with a new script `scripts/bg-remove-benchmark.mjs` that loads the library in Node (or a headless puppeteer renderer) and measures:
   - Cold start (first inference, no cache).
   - Warm start (subsequent inference, model in memory).
   - Sizes: 512², 1024², 2048².
2. Add a manual-test checklist in the README ("How to validate background removal") covering: PNG with hard edges, JPEG of a person, image with hair, image with semi-transparent glass, image with no clear foreground (negative case).
3. Visual-regression spot check: a fixed test asset with the cleanup pipeline at default settings should produce a visually-stable output across runs (model determinism).

**Acceptance:** Benchmark numbers added to `PERFORMANCE_DIAGNOSTICS.md`. Manual test checklist passes on a representative sample.

## 6. File-Level Change Manifest

| File | Change | Phase |
|---|---|---|
| `package.json` | Add `@huggingface/transformers` dependency | 0 |
| `electron/main.js` | Add WebGPU command-line switch | 0 |
| `src/bgRemoveWorker.js` | NEW — segmentation worker | 1 |
| `src/imageProcessing.js` | Add `applyMaskToImage` helper | 2 |
| `src/App.jsx` | Worker orchestration, refs, state, button, restore, error handling | 3–6 |
| `src/styles.css` | Progress strip, toolbar button states, restore button | 4 |
| `scripts/bg-remove-benchmark.mjs` | NEW — benchmark | 7 |
| `PERFORMANCE_DIAGNOSTICS.md` | Append BG-removal performance section | 7 |
| `README.md` | Append manual test checklist + new feature blurb | 7 |

No changes are required to `electron/preload.cjs`, the existing cleanup worker, or the export pipeline.

## 7. State Management Summary

New `useState` slices:
- `bgRemoveStatus: 'idle' | 'downloading' | 'warming' | 'inferring' | 'error'`
- `bgRemoveProgress: number` (0–1)

New `useRef`s:
- `bgRemoveWorkerRef`
- `bgRemoveJobIdRef` (monotonic)
- `latestBgRemoveRequestRef` (staleness counter)
- `activeBgRemoveJobRef`
- `preSegmentationOriginal` (the snapshot for Restore)

No changes to existing state.

## 8. Worker Message Protocol (Authoritative)

**Main thread → worker:**
- `{ type: 'run', id, buffer, width, height, options }`
- `{ type: 'cancel', id }` (best-effort; library may not honor mid-inference cancellation, in which case we just ignore the result)

**Worker → main thread:**
- `{ type: 'progress', id, stage, progress }`
- `{ type: 'result', id, buffer, width, height, durationMs }` with `transfer: [buffer]`
- `{ type: 'error', id, error }`

The `id` lets the main thread correlate progress and results to a specific click. The `latestBgRemoveRequestRef` lets it discard stale results when the user clicks again before the previous run finishes.

## 9. Performance Considerations

- **Cold-start cost.** First click downloads the model (~80–200 MB). Subsequent clicks reuse the IndexedDB cache. Make this cost legible to the user via the progress strip and the explicit "first-time download" toast.
- **Inference time.** Plan for ~3s on CPU, ~0.5s on WebGPU at 1024². For 2048² images, expect 8–12s on CPU, 1.5–2s on WebGPU. The library auto-downscales to its native model resolution and upsamples the mask, so wall-clock time is largely fixed regardless of source size — but downsampling fidelity matters: very high-resolution sources should be supersample-anti-aliased on mask upsample (the library does this; verify in QA).
- **Memory.** Worker peaks at ~400–600 MB during inference for the large model. This is fine for a desktop app but worth surfacing in the OOM error path.
- **Main-thread impact.** Zero, by design. The worker keeps the renderer free.
- **Battery / fan.** WebGPU inference is briefly intensive but short. CPU inference is longer and noisier. The "(CPU)" indicator in the status bar helps users understand why fans spun up.

## 10. Error and Edge Case Catalog

In addition to the categorized errors in Phase 6:

- **Image with no clear foreground.** BiRefNet sometimes returns an empty or near-empty mask. Detect via `maskMean < 0.02` and show a non-blocking toast: "We didn't detect a clear subject in this image." Do not replace `originalImageData` in this case.
- **Image already has transparency.** Allow the user to run BG removal anyway. The mask multiplies into the existing alpha, which is the correct behavior. Document in the manual test checklist.
- **Single-color images.** Model behavior is undefined; we should not crash. The empty-mask path above handles this.
- **Tiny images (<128 px on either axis).** Library may refuse or produce poor results. Pad to 128 internally before inference, then crop the mask back.
- **Animated formats (none currently supported, but for future).** Out of scope for V1.

## 11. Build and Packaging

For V1 (CDN-on-demand model):
- Vite picks up the new worker via `new URL("./bgRemoveWorker.js", import.meta.url)`.
- Electron's renderer must allow the Hugging Face CDN in its CSP. Currently the app does not set an explicit CSP; if one is added later, whitelist `https://huggingface.co` and `https://cdn-lfs.huggingface.co` or whichever model asset host Transformers.js resolves.
- No changes to electron-builder / packaging config (none exists yet for production builds; that's a separate workstream).

For a future "offline-first" mode:
- Bundle the model files into the Electron `dist/` and configure Transformers.js for local model loading instead of the Hugging Face CDN. App size grows by the model size; load time on first run is faster.
- Document this swap in this file under §15 Future Work.

## 12. Licensing

- `@huggingface/transformers`: Apache 2.0.
- `briaai/RMBG-2.0`: non-commercial/restricted model terms. This is acceptable for AlphaKiller's current non-commercial, open-source posture but must be revisited before commercial distribution.
- `hustvl/ViTMatte-base`: verify model terms before enabling the optional refinement path in a packaged release.
- Commercial escape hatch: switch Stage 1 to `ZhengPeng7/BiRefNet_HR` or another permissively licensed BiRefNet variant.

Add a short attribution paragraph to the AlphaKiller "About" section noting that background removal is powered by Transformers.js, RMBG-2.0, and ONNX Runtime Web.

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WebGPU not available in the user's Electron build | Medium | Long inference times | Detect, fall back to CPU, show "(CPU)" indicator |
| First-run download too slow on bad networks | Medium | Confused users | Progress UI; cancel button on the toast |
| Library updates change the model API | Low | Refactor cost | Pin the dependency version; review releases before bumping |
| Output mask quality insufficient on hair / glass | Medium | User dissatisfaction | Use the High-quality edges toggle, then consider a newer matting model if needed |
| Bundle size growth from ONNX runtime WASM | Low (lazy-loaded) | App startup cost | Verify lazy-load works; budget alarm if it regresses |
| IndexedDB cache collision with future features | Low | Cache eviction | Namespace the cache per Transformers.js/Hugging Face model id |

## 14. Acceptance Criteria for the Whole Feature

- [ ] User can click "Remove Background" with an image loaded; status bar and progress strip update.
- [ ] First-run download is communicated clearly and only happens once per install.
- [ ] WebGPU is used when available; CPU fallback works otherwise.
- [ ] Result replaces the source image; existing cleanup pipeline runs unchanged on the new alpha.
- [ ] "Restore Original" button reverts in one click.
- [ ] All five error categories produce specific, actionable toasts.
- [ ] No regressions to existing performance characteristics (run `npm run diagnose:perf` before/after).
- [ ] Existing tools (Defringe, Color Bleed, Threshold, Hardening, Delete Pen) still work correctly on a post-segmentation image.
- [ ] Export still produces a valid PNG.
- [ ] Memory returns to baseline within 5s of inference completion.

## 15. Future Work (Not in V1)

- **Mask-only export** — let the user export the segmentation mask as a separate PNG (alpha channel as luminance). Useful for compositing workflows.
- **Offline-bundled model** — ship the model inside the Electron package for true offline operation.
- **Model picker** — expose `small | medium | large` to power users. Today we lock it to large.
- **Hair-specialized model** — swap the model on per-image classification, or expose as an option for portrait subjects.
- **Manual mask refinement** — repurpose the Delete Pen as an "edit mask" tool that paints into the segmentation mask before final composition. This is a natural extension and would close the loop on AlphaKiller as a manual+AI hybrid.
- **Batch mode integration** — apply BG removal to every image in a batch queue (mentioned in `AlphaKiller_UI_Spec.md` §4.2 but not currently implemented).
- **GPU memory pressure on multi-image sessions** — release the model from memory after N seconds of idle to avoid keeping ~200 MB resident indefinitely.

## 16. Effort Summary

| Phase | Estimate | Cumulative |
|---|---|---|
| 0 — Project prep | 1 hour | 1 hour |
| 1 — Worker scaffolding | 4 hours | 5 hours |
| 2 — Mask composition utility | 2 hours | 7 hours |
| 3 — Worker orchestration | 4 hours | 11 hours |
| 4 — Toolbar button + UI | 4 hours | 15 hours |
| 5 — Restore/undo | 2 hours | 17 hours |
| 6 — Error handling polish | 4 hours | 21 hours |
| 7 — Testing and benchmarks | 4 hours | 25 hours |

Total: roughly **3 working days** for a single engineer, including review/iteration buffer. The plan is structured so the feature can be demo'd at the end of Phase 4 (~2 days in) and shipped at the end of Phase 6.

## 17. Out of Scope for This Plan

- Any change to the existing cleanup pipeline algorithms.
- Any change to the export flow.
- Light theme work, accessibility audit beyond keyboard reach for the new button.
- Batch processing.
- Preset import/export.
- A full undo/redo stack (beyond Restore Original).
- macOS / Windows installer signing and packaging.
