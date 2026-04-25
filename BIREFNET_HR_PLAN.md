# AlphaKiller — BiRefNet_HR Integration Plan

Companion to `BACKGROUND_REMOVAL_PLAN.md`. This document is scoped narrowly: add `ZhengPeng7/BiRefNet_HR` (or its ONNX equivalent) as a settings-toggled alternative to the currently-shipping `briaai/RMBG-1.4`, without disturbing the existing worker architecture, error handling, or matting refinement (Stage 2) path.

This plan is implementation-ready: file-level changes, worker abstractions, settings schema, and acceptance criteria. It is not code.

## 1. Goal

Give users a per-app-instance choice between:

- **Fast** — `briaai/RMBG-1.4` (currently the default; small, quick, working).
- **High-resolution** — BiRefNet_HR via the most viable ONNX route (see §3), trained at 2048² for materially better edge fidelity on large source images.

The picker lives in a Settings affordance (not in the inspector pop-out, not in the toolbar). Selection persists across sessions. Both models stay installed and cached side-by-side — the picker chooses which one runs at inference time, it does not replace the other. Both models share the existing TTA, tile-and-blend, and Stage 2 (ViTMatte) pipeline; only the Stage 1 segmentation call differs based on the user's choice.

`briaai/RMBG-2.0` remains a third future option behind the ORT-session-creation investigation noted in `BACKGROUND_REMOVAL_PLAN.md`. It is not in scope here.

## 2. Why BiRefNet_HR Specifically

- **Training resolution.** BiRefNet_HR was trained at 2048×2048 (released Feb 1 2025). RMBG-1.4 was trained at 1024×1024 and downscales internally for anything larger. For source images above ~1024 px on either edge, BiRefNet_HR retains substantially more edge detail.
- **Architecture.** BiRefNet's bilateral-reference design with a Swin-V1-Large backbone consistently beats ISNet-family models on hair, mesh, fur, and translucent edges in published benchmarks.
- **License.** MIT — commercial-safe and redistribution-friendly. Notable upgrade over BRIA's non-commercial license posture if the project's distribution stance ever changes.
- **Active maintenance.** Author Peng Zheng (ZhengPeng7) ships incremental updates and ONNX exports via GitHub releases.

## 3. Phase 0 — ONNX Availability Verification (REQUIRED BEFORE ANY CODE)

This phase exists because the integration path is not interchangeable based on what's actually published. Spend ~30 minutes here before committing to Phases 1+. The four possible outcomes drive completely different downstream work.

### 3.1 What to check

In order of preference:

**Option A — Direct from `ZhengPeng7/BiRefNet_HR` (best case).**
Visit `https://huggingface.co/ZhengPeng7/BiRefNet_HR/tree/main`. Look for:
- `onnx/` subdirectory containing `model.onnx`, `model_fp16.onnx`, `model_quantized.onnx`, etc.
- `preprocessor_config.json` at the repo root.
- `config.json` referencing an ONNX-compatible architecture string.

If all three exist: integration is straightforward. Use this repo ID directly.

**Option B — Direct from `ZhengPeng7/BiRefNet_HR-matting`.**
Same checks as above on this sibling repo. The `-matting` variant is fine-tuned for alpha matting and may already ship Transformers.js-friendly ONNX assets even if the base HR doesn't.

**Option C — Use the GitHub Releases ONNX file.**
Visit `https://github.com/ZhengPeng7/BiRefNet/releases` and look for `BiRefNet_HR-*.onnx` (~928 MB at fp32). If present:
- Download it once during development.
- Mirror it to a personal or `onnx-community`-style HF repo (with attribution and the MIT license preserved) for the app to fetch.
- Or: bundle it into the Electron app as part of the offline-first delivery path (see §14 Future Work).

**Option D — Convert from the PyTorch checkpoint.**
If no ONNX is published anywhere: use the BiRefNet repo's `tutorials/BiRefNet_pth2onnx.ipynb` or HF's `optimum-cli export onnx` to convert `ZhengPeng7/BiRefNet_HR` to ONNX. Output should target opset 17+ for ORT Web compatibility. This is a one-time developer task; the resulting ONNX is checked into a personal HF repo or bundled.

### 3.2 Operator compatibility check

Whichever ONNX file ends up in play, run it through the ORT Web operator coverage check before committing:

1. Load the ONNX file in a small Node script using `onnxruntime-node` to confirm it inferences correctly outside the browser.
2. Load the same file in a tiny browser harness using `onnxruntime-web` with `executionProviders: ['webgpu', 'wasm']` and confirm session creation succeeds. If it fails on WebGPU but succeeds on WASM, that's acceptable — the worker already falls back gracefully.
3. If session creation fails on both, this is the same class of issue blocking RMBG-2.0 today. Stop and reconsider before sinking days into integration.

### 3.3 Phase 0 deliverable

A short note appended to this document under §15 ("Verification Notes") stating:
- Which option (A, B, C, or D) was chosen.
- The exact HF repo ID and commit hash being pinned.
- Which dtype variants are available (fp32, fp16, q8, q4).
- The result of the operator-coverage smoke test (WebGPU/WASM/both).

Only after this note exists does Phase 1 begin.

## 4. Architecture Overview

The current `bgRemoveWorker.js` has two stages:

- **Stage 1**: `pipeline('image-segmentation', 'briaai/RMBG-1.4', ...)` → mask.
- **Stage 2** (opt-in): `pipeline('image-matting', 'hustvl/ViTMatte-base', ...)` → refined alpha.

After this plan lands, Stage 1 becomes a runtime dispatch over both models — both stay loaded and cached side-by-side; the message payload selects which one runs:

```
Stage 1 dispatch (per inference request):
   ├── modelId === 'rmbg-1.4'      → existing pipeline('image-segmentation', ...) path
   └── modelId === 'birefnet-hr'   → AutoModel + AutoProcessor path  (NEW)
```

Both branches live in the worker simultaneously. The first request for each model triggers a one-time download into IndexedDB; subsequent requests use the cache. Switching the picker mid-session does not invalidate either cache.

Stage 2 is unchanged. TTA, tile-and-blend, cancellation, progress events, and error categorization are unchanged. The mask shape returned to the main thread is unchanged (single-channel `Uint8Array` at source resolution).

The dispatch happens entirely inside `bgRemoveWorker.js`. The main thread sends one new field — `options.modelId` — and is otherwise oblivious to which model ran.

## 5. Why BiRefNet_HR Needs a Different Code Path

BiRefNet variants — including all `onnx-community/BiRefNet-*-ONNX` mirrors and the original ZhengPeng7 repos — do not register under Transformers.js's `image-segmentation` pipeline task. The task dispatcher expects models with a specific output head (typically logits with a class dimension); BiRefNet outputs a single-channel sigmoid mask via a custom forward signature.

The community-confirmed integration pattern is:

```javascript
// Illustrative — do not copy verbatim. Final form goes in bgRemoveWorker.js.
import { AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';

const model = await AutoModel.from_pretrained(repoId, {
  dtype: 'fp16',          // or 'fp32' for max quality, 'q8' for memory-tight
  device: 'webgpu'        // with same WASM-fallback chain we already have
});
const processor = await AutoProcessor.from_pretrained(repoId);

const rawImage = new RawImage(rgbaBuffer, width, height, 4);
const { pixel_values } = await processor(rawImage);
const output = await model({ input_image: pixel_values });
// output is a tensor with shape [1, 1, H, W] containing post-sigmoid mask values in [0, 1]
```

This is meaningfully different from the RMBG path in three ways:

1. **Two-call instantiation** (`AutoModel` + `AutoProcessor`) instead of one-call (`pipeline`).
2. **Manual forward signature** — the input tensor name is `input_image`, not the default `pixel_values` Transformers.js implies.
3. **Output is already sigmoid-activated** in BiRefNet's ONNX exports — do not apply sigmoid again. The RMBG-1.4 path receives logits and applies sigmoid in post-processing; that branch must be skipped for BiRefNet.

A single `runStage1ForBiRefNet(...)` function in the worker — parallel to the existing RMBG path — encapsulates all of this.

## 6. Implementation Phases

Each phase is self-contained and shippable. The app keeps working at the end of every phase.

### Phase 1 — Persisted settings layer (≈ half day, low risk)

Today preferences are localStorage-only and only the HF token is stored. Adding a model picker without a real settings layer is feasible but invites scope creep later.

**Two viable approaches; pick one:**

**1a. Lightweight (recommended for V1).** Extend the existing localStorage usage:
- Storage keys: `alphakiller:bg-remove-model` (string), `alphakiller:bg-remove-refine-default` (boolean).
- Read at boot in `App.jsx`, write on user change.
- Migrate the existing `alphakiller:hf-token` key under the same namespace prefix for consistency.
- No new dependency.

**1b. Dependency-based.** Add `electron-store` and route preferences through main-process IPC. Better long-term, but requires preload changes and a settings IPC channel. Recommend deferring until there are 4+ persisted preferences.

V1 ships with 1a. Plan should anticipate migration to 1b later.

**Acceptance:** Storing and reading the new keys works. localStorage survives app restart in dev mode. Existing HF token behavior is unchanged.

### Phase 2 — Worker model abstraction (≈ half day, medium risk)

Refactor `bgRemoveWorker.js` so the Stage 1 path is dispatched by `options.modelId`:

**New constants:**
```
const STAGE1_MODELS = {
  'rmbg-1.4': {
    repoId: 'briaai/RMBG-1.4',
    runtime: 'pipeline',
    task: 'image-segmentation',
    config: { model_type: 'segformer' }
  },
  'birefnet-hr': {
    repoId: '<resolved in Phase 0>',
    runtime: 'automodel',
    inputName: 'input_image',
    nativeResolution: 2048,
    expectsSigmoid: true,        // skip sigmoid in post-processing
    normalization: 'imagenet'    // mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]
  }
};
```

**Refactor (everything additive — no functionality is removed):**
- Convert the single `stage1Promise` into a map keyed by `modelId`. Each ID gets its own load promise; both stay populated once loaded, so switching back and forth between models does not trigger re-downloads.
- Generalize `loadStage1` into `loadStage1ForModel(modelId)` that branches on `runtime`. The 'pipeline' branch is the existing code, lifted unchanged. The 'automodel' branch is new (~30 LOC).
- Generalize `runStage1` into `runStage1ForModel(source, modelId, options)` that calls either `runRmbgPipeline(...)` (existing code, lifted into a named function) or `runBiRefNet(...)` (new).
- Cache both `model` and `processor` instances when the AutoModel branch runs.

**Acceptance:** A debug message (`{ type: 'run', modelId: 'rmbg-1.4', ... }`) still produces a working mask. A second debug message with `modelId: 'birefnet-hr'` produces a different mask but does not error. Sanity check: `meanMask` returns >0.05 for a synthetic image with a clear subject, both paths.

### Phase 3 — BiRefNet pre/post-processing (≈ half day, medium risk)

This phase implements `runBiRefNet(source, options)`. Most of the work is in three helper functions:

**a. `preprocessForBiRefNet(rawImage, targetSize) → Float32Tensor`**
- Resize to `targetSize × targetSize` (1024 for default, 2048 for HR variant). Use bilinear resampling consistent with how the original PyTorch model trained.
- Convert to `[1, 3, H, W]` Float32 tensor.
- Apply ImageNet normalization: `(pixel/255 - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]`.
- Return tensor and the original-vs-resize scale factors for upsampling later.

**b. `postprocessBiRefNet(maskTensor, sourceWidth, sourceHeight) → Uint8Array`**
- Take the `[1, 1, H, W]` output. The values are already in `[0, 1]` (sigmoid activated in the ONNX graph).
- Bilinear upsample to source resolution.
- Multiply by 255 and quantize to `Uint8Array`.

**c. `processorIsCompatible(processor)` (defensive)**
- After `AutoProcessor.from_pretrained(repoId)`, sanity check the `image_mean`, `image_std`, and `size` it loads. If any disagree with the `STAGE1_MODELS['birefnet-hr']` constants, log a warning. This catches the case where the pinned repo updates its preprocessor config without us noticing.

**Caveat — TTA orthogonality.** The existing TTA implementation flips/rotates the input *before* preprocessing and un-flips *after* postprocessing. As long as `preprocessForBiRefNet` and `postprocessBiRefNet` are called from inside the existing TTA loop, no TTA changes are required.

**Caveat — tiling.** The existing tile-and-blend logic produces 1536² tiles for 2048–4096² inputs and 1024² tiles above 4096². For BiRefNet_HR, a strong default is to use 2048² tiles below 4096² (matching the model's training resolution), with the existing 128 px overlap and raised-cosine blend. Add a `nativeResolution` field on the model descriptor (already in §6.2) so `chooseTileStrategy` reads from it.

**Acceptance:** A unit-style test (in the smoke script) confirms a 1024² synthetic image produces a mask whose mean differs from RMBG-1.4's by less than 30% on a known-subject image and >50% on a known-no-subject image. The two models should agree about the existence of a subject; they should disagree about the precise edges.

### Phase 4 — Tile strategy adaptation (≈ 2 hours, low risk)

Update the strategy table in `chooseTileStrategy` (or equivalent in the worker) so it reads the model's native resolution:

```
function chooseTileStrategy(width, height, modelId) {
  const native = STAGE1_MODELS[modelId].nativeResolution ?? 1024;
  const max = Math.max(width, height);

  if (max <= native)               return { mode: 'native' };
  if (max <= native * 2)           return { mode: 'tile', tileSize: native, overlap: 128 };
  return                                    { mode: 'tile', tileSize: Math.max(1024, native / 2), overlap: 128 };
}
```

**Acceptance:** A 2048² image runs natively under `birefnet-hr` (no tiling) and tiles cleanly at 4096²+. The existing benchmark script (`bg-remove-benchmark.mjs`) gains two new sizes — 2048 and 3072 — that complete without crash.

### Phase 5 — Settings UI (≈ half day, low risk)

The user-facing surface lives in a small Settings panel reachable from a gear icon in the top-right of the toolbar (or under an "About / Settings" menu item — pick whichever fits the existing UX best; do not re-litigate UX).

**Settings panel content (V1 minimum):**

| Control | Bound to | Notes |
|---|---|---|
| Model picker (radio group) | `bg-remove-model` | "Fast (RMBG-1.4)" / "High-resolution (BiRefNet_HR)" |
| Default refine on | `bg-remove-refine-default` | Initializes the inspector toggle on app start |
| HF access token | `alphakiller:hf-token` | Migrated from the existing input |

**Picker copy:**
- "Fast (RMBG-1.4)" — "Smaller download (~70 MB), good for previews and most images."
- "High-resolution (BiRefNet_HR)" — "Larger download (~440 MB at fp16). Best for images above 1024 px on a side. MIT-licensed."

**Behavior:**
- Switching models mid-session does NOT replay the last BG-remove run automatically. The user clicks "Remove Background" again to apply the new model.
- The first run after switching shows the existing first-run download toast (since the new model isn't cached yet).
- If the user cancels mid-download by switching back, the in-flight request is allowed to complete in the background and cache. No special handling needed.

**Acceptance:** Picker is reachable by keyboard. Selection survives app restart. Switching to BiRefNet_HR with no cache, then clicking Remove Background, shows the download progress strip and completes.

### Phase 6 — Diagnostics + benchmarks (≈ 2 hours, low risk)

- `scripts/hf-access-check.mjs`: already accepts `HF_MODEL_ID` env override. Document the BiRefNet_HR repo ID in the README for users to probe.
- `scripts/bg-remove-smoke.mjs`: parameterize on `ALPHAKILLER_BG_MODEL` (defaults to current behavior). Add a CI-friendly env flag that runs the smoke twice — once per model.
- `scripts/bg-remove-benchmark.mjs`: emit timings per model so regressions surface cleanly.
- Append a "BiRefNet_HR baselines" subsection to `PERFORMANCE_DIAGNOSTICS.md` with cold/warm timings at 1024², 2048², 3072² for both WebGPU and WASM fallback.

**Acceptance:** `npm run benchmark:bg-remove -- --model birefnet-hr` produces a clean numeric table.

## 7. State Schema (Additive)

**App.jsx new state:**
```
const [bgRemoveModel, setBgRemoveModel]
  = useState(() => loadPersistedModel() ?? 'rmbg-1.4');
```

**App.jsx new ref (optional — needed only if the smoke test wants to inspect it):**
```
const lastBgRemoveModelRef = useRef(null);
```

**Worker payload addition (one new field):**
```
{
  type: 'run',
  id, buffer, width, height,
  options: {
    ...existing,
    modelId: 'rmbg-1.4' | 'birefnet-hr'   // NEW; required
  }
}
```

**Worker result payload addition (one new field):**
```
{
  type: 'result',
  ...existing,
  modelId: <whichever ran>                  // for diagnostics + status bar
}
```

No other state changes. `bgRemoveStatus`, `bgRemoveProgress`, `bgRemoveDevice`, `bgRemoveRefine`, and the snapshot ref are model-agnostic.

## 8. Performance Expectations

Wall-clock estimates from published BiRefNet benchmarks and Transformers.js community reports. Treat as ranges, not commitments.

| Scenario | RMBG-1.4 (current) | BiRefNet_HR (planned) |
|---|---|---|
| 1024² inference, WebGPU fp16 | ~0.4–0.8s | ~0.8–1.2s |
| 1024² inference, WASM int8 | ~3–5s | ~6–10s |
| 2048² native, WebGPU fp16 | n/a (downscales) | ~1.5–2.5s |
| 2048² native, WASM | n/a | ~25–40s (likely unusable) |
| First-run download | ~70 MB | ~440 MB fp16 / ~885 MB fp32 |
| Resident memory (loaded) | ~120 MB | ~600–900 MB |

Headlines:
- BiRefNet_HR is ~2× slower than RMBG-1.4 on equivalent inputs but produces materially better edges, especially above 1024 px.
- On WASM-only machines (no WebGPU), BiRefNet_HR at native 2K is too slow to ship as the default. The model picker should show a one-line warning if `navigator.gpu` is falsy.
- Memory pressure is the real risk. A 2048² fp32 forward pass can peak above 1.5 GB. Recommend defaulting to fp16 on WebGPU and quantized variants on WASM.

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| BiRefNet_HR has no Transformers.js-ready ONNX in any HF repo | Medium | Phase 0 blocks; convert from PyTorch ourselves | Explicit Phase 0 verification step. Fallback: convert via `optimum-cli` and host in a personal HF repo. |
| Operators in BiRefNet_HR's ONNX are not supported by ORT Web | Medium | Same class of issue blocking RMBG-2.0 | Phase 0.2 operator-coverage smoke test catches this before commitment. Fallback: drop BiRefNet_HR from the picker, recommend RMBG-1.4 + Stage 2 as the quality path. |
| Model size (~440 MB+) creates a bad first-run UX | High | User abandons download | First-run toast copy explicitly calls out the size; progress strip stays visible; picker tooltip warns about the download budget. |
| WASM fallback is unusable at 2048² | High | CPU-only users have a broken "High-resolution" option | Detect `!navigator.gpu` at picker render time and either disable BiRefNet_HR with explanatory tooltip, or downgrade to 1024² inference for that user. |
| Native-resolution inference at 2048² OOMs on 8 GB machines | Medium | Worker crash | Already-implemented OOM error toast handles this. Add a "downgrade to 1024²" auto-retry on first OOM before surfacing the error. |
| Settings localStorage migration corrupts existing token | Low | User has to re-paste HF token | Backup the old key on first read; only delete after successful migration. |
| TTA × native 2K × WebGPU exceeds budget | Medium | Long inference times | TTA already auto-reduces from 4× to 2× for very large images; extend the threshold to also reduce when `modelId === 'birefnet-hr'`. |
| Stage 2 (ViTMatte) interaction differs with BiRefNet output | Low | Mask quality regression | Stage 2 takes the Stage 1 mask as a trimap regardless of source. Should be neutral. Verify with manual test on a hair image. |
| BiRefNet output is RGBA, not single-channel mask, on some variants | Low | Post-processing fails silently | Phase 0 inspection of `config.json` confirms output shape `[1, 1, H, W]` before commitment. |

## 10. File-Level Change Manifest

| File | Change | Phase |
|---|---|---|
| `BIREFNET_HR_PLAN.md` | THIS FILE | n/a |
| `package.json` | No change (Transformers.js already installed) | n/a |
| `src/bgRemoveWorker.js` | Refactor to model-dispatched Stage 1; add `runBiRefNet`, `preprocessForBiRefNet`, `postprocessBiRefNet`, model descriptor map | 2, 3, 4 |
| `src/App.jsx` | New state slice, payload propagation, settings panel mount | 1, 5 |
| `src/SettingsPanel.jsx` | NEW — model picker, refine default, HF token | 5 |
| `src/styles.css` | Settings panel styles | 5 |
| `scripts/bg-remove-smoke.mjs` | Parameterize on `ALPHAKILLER_BG_MODEL` | 6 |
| `scripts/bg-remove-benchmark.mjs` | Loop over both models per size | 6 |
| `PERFORMANCE_DIAGNOSTICS.md` | Append BiRefNet_HR baselines | 6 |
| `README.md` | Document model picker; document HF_MODEL_ID env override for diagnose:hf | 6 |

## 11. Acceptance Criteria for the Whole Feature

- [ ] Phase 0 verification note exists in §15 with the chosen ONNX route documented.
- [ ] Settings panel reachable, picker shows two options, persists across restart.
- [ ] Selecting "High-resolution" + clicking Remove Background downloads the model on first use, shows progress, completes successfully.
- [ ] Switching back to "Fast" uses the cached RMBG-1.4 instantly.
- [ ] Stage 2 (refine) works in combination with both models.
- [ ] No regressions to RMBG-1.4's existing performance characteristics. `npm run benchmark:bg-remove` baseline numbers within ±5% of pre-change.
- [ ] WASM-only machines either get BiRefNet_HR disabled with a clear tooltip, or run it with a "(CPU, slow)" indicator that is honest about the wait.
- [ ] HF access dialog correctly identifies the right model when permissions fail (`HF_MODEL_ID` env override is plumbed through).
- [ ] Smoke test passes for both models.
- [ ] Restore Original works with both models.
- [ ] Memory returns to baseline within 60s of an idle period (this is a separately desired feature; if it lands as part of this work, gate it on either model loading, not just BiRefNet_HR).

## 12. Effort Summary

| Phase | Estimate (best case) | Estimate (with risk) |
|---|---|---|
| 0 — ONNX availability + ORT smoke test | 30 min | up to 2 hours if conversion needed |
| 1 — Settings persistence | 4 hours | 4 hours |
| 2 — Worker model abstraction | 4 hours | 6 hours |
| 3 — BiRefNet pre/post-processing | 4 hours | 8 hours (TTA edge cases) |
| 4 — Tile strategy adaptation | 2 hours | 3 hours |
| 5 — Settings UI | 4 hours | 4 hours |
| 6 — Diagnostics + benchmarks | 2 hours | 3 hours |
| **Total** | **~2.5 days** | **~3.5 days** |

The plan is structured so the feature can be demo'd with a debug-only model toggle at the end of Phase 3 (~1.5 days in) and shipped to users at the end of Phase 5.

If Phase 0 yields outcome **D** (must convert from PyTorch ourselves), add ~half a day for the conversion + verification, and another half-day for setting up a personal HF repo to host the converted artifact.

## 13. Out of Scope

- `briaai/RMBG-2.0` integration (separate ORT-session investigation in main plan).
- Any other BiRefNet variants: `BiRefNet_T`, `BiRefNet_lite`, `BiRefNet-portrait`, `BiRefNet-COD`, `BiRefNet-DIS5K`. Worth considering as future "model gallery" work but not now.
- An advanced settings panel (cache management, dtype override, tile size override).
- Idle-timer model release. Listed in `BACKGROUND_REMOVAL_PLAN.md` §9 as a separate workstream.
- `electron-store` migration. Deferred to whenever a 4th persisted preference appears.
- A "compare models side-by-side" UI. Tempting but bloats scope.
- Bundling the model into the Electron `.app` for offline-first delivery. Future work.

## 14. Future Work (Adjacent, Not This Plan)

- **Model gallery.** Once the dispatch infrastructure from Phase 2 exists, adding more models is a 2-hour exercise per model. Easy follow-ups: BiRefNet-portrait for portrait-specific cleanup, BiRefNet_T for an even smaller "Fast" tier.
- **Hybrid quality tier.** Run RMBG-1.4 first for a fast preview, kick off BiRefNet_HR in parallel, swap to its result when ready. Good UX but requires a meaningfully different orchestration pattern.
- **Offline-bundled BiRefNet_HR.** Ship the ONNX inside the `.app` so the first-run download disappears. ~440 MB cost on disk for a much better cold-start UX.

## 15. Verification Notes

```
ONNX route chosen: C
Repo ID:           GitHub release asset from ZhengPeng7/BiRefNet
Asset:             BiRefNet_HR-general-epoch_130.onnx
Release/tag:       https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1
Pinned commit:     a0cf9925880620000aa2d1948d61bf659ddfdfaa
Available dtypes:  fp32 ONNX only for the HR general release asset tested
ORT Node:          session create pass; fixed input shape is [1, 3, 2048, 2048]
ORT WebGPU:        session create pass; forward pass fail
ORT WASM:          session create pass; full forward not viable in Phase 0 CPU budget
Tester:            Codex
Tested on:         2026-04-25
Notes:
  - Option A checked: ZhengPeng7/BiRefNet_HR on Hugging Face at sha a7a562f6fd16021180f2f4348f4de003a2d3d1e1. It has config/custom code/model.safetensors, but no onnx/ directory and no preprocessor_config.json.
  - Option B checked: ZhengPeng7/BiRefNet_HR-matting on Hugging Face at sha 5d6b6f8adcb5b417c871b1d84ceaae9871355b7f. It has config/custom code/model.safetensors, but no onnx/ directory and no preprocessor_config.json.
  - Existing onnx-community mirrors were checked; none is the HR model. Available mirrors include BiRefNet-ONNX, DIS5K, HRSOD_DHU, portrait, lite, and 512x512 variants.
  - Node ORT session creation succeeded with input name input_image and output name output_image. A 256x256 dummy input was correctly rejected because the ONNX expects 2048x2048. A 2048x2048 CPU forward did not complete after roughly 5.5 minutes and was killed.
  - ORT Web WASM session creation succeeded from local model bytes in about 6.1s.
  - Electron ORT WebGPU session creation succeeded with navigator.gpu=true in about 9.2s after local model fetch.
  - Electron/browser forward pass failed with: RuntimeError: null function or function signature mismatch. The stack reported ort-wasm-simd-threaded.asyncify.wasm, so this is not safe to integrate behind a user-facing picker yet.
  - Verdict: do not begin Phase 1 for BiRefNet_HR until either a browser-forward-compatible ONNX is produced/hosted or the ORT Web runtime failure is resolved. Option C is available as a source artifact, but not cleared for AlphaKiller runtime integration.
```
