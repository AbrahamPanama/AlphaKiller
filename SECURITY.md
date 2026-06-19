# Security Notes

AlphaKiller is a local-first Electron app. The renderer should not receive Node
integration, and privileged filesystem work should stay behind the preload IPC
bridge.

## Current Electron posture

- `contextIsolation` is enabled.
- `nodeIntegration` is disabled.
- The preload bridge exposes only theme lookup, optional Hugging Face token
  lookup, main-process background-removal IPC, and native PNG/JPEG/TIFF/PDF/SVG export.
- IPC handlers validate their caller and payload shape before handling requests.
- WebGPU is enabled because background removal depends on ONNX Runtime Web.

## Hugging Face tokens

For development, AlphaKiller can read a token from `ALPHAKILLER_HF_TOKEN`,
`HF_TOKEN`, or `HF_ACCESS_TOKEN` in the Electron process. Browser-only previews
can use `localStorage.setItem("alphakiller:hf-token", "...")`, but that is a
development convenience, not a production credential strategy.

Do not commit tokens, screenshots containing tokens, exported browser profiles,
or cache folders containing private model artifacts.

## BRIA API tokens

Hosted RMBG-2.0 uses `BRIA_API_TOKEN` or `ALPHAKILLER_BRIA_API_TOKEN` from the
Electron main-process environment. The renderer sends PNG bytes over IPC and
does not receive the environment token. The Settings panel also supports a
local BRIA token override for development; that token is stored in the browser
profile and sent to the main process only for BRIA requests. Prefer environment
tokens for production-style runs. Do not store BRIA tokens in source files,
screenshots, logs, or packaged renderer assets.

## Reporting issues

Please open a GitHub issue for security hardening gaps that do not expose
private data. If a future release process adds signed installers or auto-update,
add a private vulnerability reporting channel before shipping those builds.
