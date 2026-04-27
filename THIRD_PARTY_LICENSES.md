# Third-Party Licenses and Model Notices

AlphaKiller's application source is licensed under the repository `LICENSE`.
Third-party packages and remotely downloaded model weights remain under their
own licenses and terms.

## Runtime Dependencies

| Component | Role | License / notice |
|---|---|---|
| `@huggingface/transformers` | Browser/worker model runtime | Apache-2.0 |
| `onnxruntime-web` | ONNX execution engine used by Transformers.js | MIT |
| `react`, `react-dom` | Renderer UI | MIT |
| `electron` | Desktop shell | MIT |
| `vite`, `@vitejs/plugin-react` | Development/build tooling | MIT |
| `lucide-react` | Icons | ISC |
| `utif` | TIFF decoding and transparent TIFF export | MIT |
| `playwright-core` | Diagnostic browser automation | Apache-2.0 |

## Hosted APIs

| Provider | Current use | Notice |
|---|---|---|
| BRIA API RMBG-2.0 | Experimental hosted background-removal provider | Requires a BRIA API token and is governed by BRIA's API terms. Images are uploaded to BRIA for processing. |

## Remote Model Weights

AlphaKiller does not commit model weights to this repository. Background
removal models are downloaded on demand from Hugging Face and cached locally by
the runtime.

| Model | Current use | Notice |
|---|---|---|
| `briaai/RMBG-1.4` | Default Stage 1 background-removal model | Review the Hugging Face model card and BRIA terms before redistribution or commercial use. |
| `onnx-community/BEN2-ONNX` | WebGPU-only Quality background-removal model | MIT; downloaded on demand from Hugging Face. |
| `hustvl/vitmatte-base-distinctions-646` | Investigated high-quality edge refinement | Apache-2.0, but currently not used because the repo has no browser-ready ONNX assets. |
| `briaai/RMBG-2.0` | Planned/future quality target | Gated on Hugging Face and not the current default implementation. |
| `ZhengPeng7/BiRefNet_HR` | Investigated future quality tier | MIT-licensed project, but current browser/ORT compatibility is blocked; see `BIREFNET_HR_PLAN.md`. |

RMBG-2.0 provider notes:

- `bria-api`: hosted BRIA API; requires `BRIA_API_TOKEN` and applicable BRIA
  API terms.
- Future `hf-pytorch`: Hugging Face RMBG-2.0 weights are non-commercial unless
  a commercial self-hosted agreement is obtained.
- Future `hf-onnx-webgpu`: experimental local ONNX route with the same model
  license constraints as the Hugging Face model.

Before publishing a packaged desktop release, re-check every model card and
dependency license against the exact versions being shipped or downloaded.
