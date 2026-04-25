# Security Notes

AlphaKiller is a local-first Electron app. The renderer should not receive Node
integration, and privileged filesystem work should stay behind the preload IPC
bridge.

## Current Electron posture

- `contextIsolation` is enabled.
- `nodeIntegration` is disabled.
- The preload bridge exposes only theme lookup, optional Hugging Face token
  lookup, and PNG export.
- IPC handlers validate their caller and payload shape before handling requests.
- WebGPU is enabled because background removal depends on ONNX Runtime Web.

## Hugging Face tokens

For development, AlphaKiller can read a token from `ALPHAKILLER_HF_TOKEN`,
`HF_TOKEN`, or `HF_ACCESS_TOKEN` in the Electron process. Browser-only previews
can use `localStorage.setItem("alphakiller:hf-token", "...")`, but that is a
development convenience, not a production credential strategy.

Do not commit tokens, screenshots containing tokens, exported browser profiles,
or cache folders containing private model artifacts.

## Reporting issues

Please open a GitHub issue for security hardening gaps that do not expose
private data. If a future release process adds signed installers or auto-update,
add a private vulnerability reporting channel before shipping those builds.
