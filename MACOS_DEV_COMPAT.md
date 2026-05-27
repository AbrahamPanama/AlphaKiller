# AlphaKiller — macOS Developer Compatibility

Prepared: 2026-04-27

This document is the current macOS development and packaging guide for
AlphaKiller 0.1 beta. It replaces older handoff notes that described missing
devDependencies, Windows-only helper scripts, and obsolete Electron versions.

## Current Stack

| Layer | Current choice |
|---|---|
| Desktop shell | Electron 39 |
| Renderer | Vite 7 + React 19 |
| Local AI inference | `@huggingface/transformers` in Web Workers |
| Packaging | `electron-builder` |
| TIFF support | `utif` |

## macOS Prerequisites

Use Node.js 22 LTS or newer. The project also works with modern Node 20, but
CI and local development currently use Node 22.

```bash
brew install node
node --version
npm --version
```

## Clean Clone Setup

```bash
git clone https://github.com/AbrahamPanama/AlphaKiller.git
cd AlphaKiller
npm ci
```

All required runtime and development dependencies are now declared in
`package.json`. You should not need to manually add Electron, Vite, or
electron-builder.

## Running the App

```bash
npm run dev
```

The dev script starts Vite on `127.0.0.1` and launches Electron after the dev
server is reachable. A separate two-terminal workflow is not required.

Useful narrow commands:

```bash
npm test
npm run build
npm run diagnose:perf
npm run diagnose:bg-remove
```

The hosted BRIA RMBG-2.0 diagnostic requires a token:

```bash
BRIA_API_TOKEN=your_bria_api_token npm run diagnose:rmbg2:api
```

Do not commit real tokens. Prefer environment variables for production-style
runs.

## macOS-Specific Notes

- `electron/main.js` uses the macOS hidden inset titlebar and keeps the app
  alive after the last window closes, matching normal macOS app behavior.
- `electron/preload.cjs` is intentionally CommonJS because it runs in Electron's
  preload context while the package itself is ESM.
- `vite.config.js` sets `base: "./"` so packaged Electron builds can load
  renderer assets from `file://` URLs.
- WebGPU is enabled in Electron through command-line switches because local
  background-removal models depend on ONNX Runtime Web acceleration.

## Building on macOS

Build the renderer only:

```bash
npm run build
```

Build a macOS DMG:

```bash
npm run dist:mac
```

By policy, the default macOS build targets Apple Silicon (`arm64`). Windows x86
compatibility is handled by the Windows build scripts, not the macOS build.

For an explicit Apple Silicon test build:

```bash
npm run dist:mac:arm64
```

The current beta uses Electron's default app icon. A custom macOS `.icns` icon
can be added later under the electron-builder `mac.icon` setting.

## Windows Builds From macOS

The repo includes:

```bash
npm run dist:win
```

By policy, the default Windows build produces both:

- `x64` for modern 64-bit Windows.
- `ia32` for 32-bit x86 Windows compatibility.

For single-architecture test builds:

```bash
npm run dist:win:x64
npm run dist:win:ia32
```

On macOS this can produce unsigned Windows NSIS installers through
electron-builder's cross-build helpers, but the most reliable Windows release
path is to build on a Windows machine or a `windows-latest` GitHub Actions
runner. The included `install-windows.bat` is intended to be run on Windows from
inside a clean clone and launches the matching installer for that machine.
Portable Windows executables are still available with:

```bash
npm run dist:win:portable
```

Use portable builds only when a no-install executable is specifically needed.
They can launch slowly because the app has to unpack itself before running.

Unsigned Windows builds can trigger SmartScreen. That is expected until the app
has code-signing certificates and a formal release pipeline.

## Known Packaging Gaps

- macOS builds are not notarized or signed.
- Windows builds are not signed.
- There is no custom application icon yet.
- Release artifacts should be attached to GitHub Releases rather than committed
  to the repository.
