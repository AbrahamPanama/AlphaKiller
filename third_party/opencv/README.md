# OpenCV Runtime Artifacts

`5.0.0/` is AlphaKiller's pinned OpenCV WebAssembly runtime location.

The checked-in module and WASM files are harmless clean-clone placeholders.
While their manifest status is `not-built`, `src/opencvRuntime.js` loads the
exact OpenCV 5.0.0 npm mirror declared in `package.json`. Run
`scripts/opencv/build-opencv5.sh` to replace the placeholders with artifacts
built from the official pinned source. `runtime-manifest.json` records whether
real artifacts are present and, after a build, their SHA-256 hashes.

Do not replace these files manually with an npm or CDN build: that would bypass
the source and toolchain pins documented in `scripts/opencv/versions.env`.
