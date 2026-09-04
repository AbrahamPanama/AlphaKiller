# AlphaKiller — macOS Developer Compatibility

Prepared: 2026-09-02

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

`dist:mac` and `dist:mac:arm64` are intentionally local-development commands.
They keep Electron Builder's signing identity set to `null` and notarization
disabled, so contributors do not need Apple credentials and local packaging
continues to produce an unsigned test build. Do not distribute that artifact;
Gatekeeper warnings are expected on another Mac.

For an explicit Apple Silicon test build:

```bash
npm run dist:mac:arm64
```

The packaged app uses `build/icon.icns`. Release builds enable Hardened Runtime
and apply the narrowly scoped entitlements in `build/entitlements.mac.plist`
and `build/entitlements.mac.inherit.plist`. AlphaKiller needs the JIT entitlement
for Electron's V8 runtime; it does not enable the Mac App Store sandbox or add
unrelated device, file, or network entitlements. The beta suffix stays in the
package and artifact version, while the macOS bundle uses Apple's numeric
version fields (`0.1.0` marketing version and build `5`). Increment the numeric
`mac.bundleVersion` for every later macOS release build.

## Signed and Notarized Releases

`.github/workflows/release-macos.yml` runs only for pushed `v*` tags. It rejects
a tag unless it is exactly `v` followed by the version in `package.json`, runs
the full verification suite, builds the Apple Silicon DMG on macOS, signs the
app with a Developer ID Application certificate, submits it to Apple's notary
service, and verifies the signature, stapled ticket, Gatekeeper assessment, and
DMG integrity against the app mounted from the final image. It then creates a
GitHub prerelease for prerelease versions and attaches the DMG plus its SHA-256
checksum.

The release-only command is:

```bash
npm run build
npm run dist:mac:release
```

`electron-builder.release.cjs` removes the local `identity: null` override,
sets `forceCodeSigning: true`, enables Electron Builder's notarization step,
and validates the credential environment before packaging. Missing signing or
notarization credentials therefore fail the release rather than silently
producing a public unsigned build. The release workflow runs `npm run verify`
before exposing Apple credentials, so `dist:mac:release` packages the already
built renderer and does not rebuild application code while secrets are present.

### Required GitHub Actions secrets

Create a GitHub Environment named `macos-release` under **Repository settings →
Environments**, add a required reviewer, and restrict it to protected release
tags where the repository plan supports those controls. Add the following as
environment secrets. The job will not receive them until its environment is
approved. Certificate and private-key files are ignored by Git and must never
be committed. Also add a repository ruleset for `v*` tags so only designated
release managers can create or update them.

Signing always requires:

| Secret | Value |
|---|---|
| `CSC_LINK` | Base64-encoded `.p12` export containing the **Developer ID Application** certificate and its private key |
| `CSC_KEY_PASSWORD` | Password used when exporting that `.p12` file |

For notarization, the preferred option is an App Store Connect Team API key
(not an Individual key) with **App Manager** access. Apple Individual API keys
cannot access `notarytool`:

| Secret | Value |
|---|---|
| `APPLE_API_KEY_P8_BASE64` | Base64-encoded contents of the App Store Connect `.p8` private key |
| `APPLE_API_KEY_ID` | App Store Connect Team API key ID |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |

The workflow decodes `APPLE_API_KEY_P8_BASE64` into the runner's temporary
directory because Electron Builder expects `APPLE_API_KEY` to be a file path,
then deletes that temporary file after packaging.

Alternatively, configure all three Apple ID credentials:

| Secret | Value |
|---|---|
| `APPLE_ID` | Apple Developer account email address |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password created for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

When both notarization methods are configured, the workflow uses the App Store
Connect API key. GitHub provides `GITHUB_TOKEN` automatically; it is not a
custom secret. The workflow grants that token only `contents: write`, which is
needed to create the GitHub release.

### Publishing 0.1.0-beta.5

After the intended release commit is reviewed and merged, verify the package
version and push its matching annotated tag:

```bash
test "$(node -p "require('./package.json').version")" = "0.1.0-beta.5"
git tag -a v0.1.0-beta.5 -m "AlphaKiller 0.1.0-beta.5"
git push origin v0.1.0-beta.5
```

The workflow also rejects tags whose commit is not reachable from `main`.
Pushing the tag is the publication action, subject to approval of the
`macos-release` environment. Do not reuse or move a published release tag;
increment `package.json` and create a new tag for another build.

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
has Windows code-signing certificates and a Windows signing pipeline.

## Known Packaging Gaps

- Public macOS releases currently target Apple Silicon only; there is no Intel
  or universal DMG.
- Windows builds are not signed.
- Local macOS packages remain unsigned by design; only the tag workflow creates
  distributable signed and notarized artifacts.
- Automatic application updates are not configured.
- Release artifacts are attached to GitHub Releases rather than committed to
  the repository.
