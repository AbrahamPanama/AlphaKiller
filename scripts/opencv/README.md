# AlphaKiller OpenCV 5 Runtime

This directory builds a small OpenCV 5 WebAssembly runtime from official,
pinned sources. Until that optional custom artifact is built, AlphaKiller uses
the exact `@techstark/opencv-js@5.0.0-release.1` dependency, an npm mirror of
the official OpenCV 5.0.0 JavaScript build. No moving CDN artifact is used.

## Pins

- OpenCV `5.0.0`, commit `40738fb16ceddb5fb3fea747585f7ce6abb0605b`
- Source archive SHA-256 `23affb17b8f7a46517a62b5e9fa637a8bc660acb5460bef9f130ee939df01ebb`
- Emscripten `4.0.20`
- Docker image index digest `sha256:460fff8f8ac87e11b16447fbd66538a686eafa0e4fb977aa0989ed19fe2079f7`
- OpenCV-contrib is pinned in `versions.env` for a later `ximgproc` binding
  experiment, but it is not part of this foundation build.

The official OpenCV JavaScript build script is used directly. The raw
Emscripten output is packaged as an ES module so it can load inside AlphaKiller's
existing module workers without `importScripts`, `eval`, or a global `cv`.

## Prerequisites

Recommended on macOS, Linux, and Windows with WSL/Git Bash:

- Git
- curl
- Python 3
- Node.js 20 or newer
- Docker Desktop with at least 8 GB memory and roughly 4 GB free disk

Check the host:

```bash
bash scripts/opencv/check-prerequisites.sh
```

The Docker build uses a digest-pinned Emscripten image and does not require a
host CMake installation:

```bash
bash scripts/opencv/build-opencv5.sh --docker
```

For a local build, install and activate emsdk `4.0.20`, plus CMake and make:

```bash
./emsdk install 4.0.20
./emsdk activate 4.0.20
source ./emsdk_env.sh
bash scripts/opencv/build-opencv5.sh --local
```

Download and verify the official source without compiling:

```bash
bash scripts/opencv/build-opencv5.sh --source-only
```

Build outputs are written to `third_party/opencv/5.0.0/` and the manifest is
updated with artifact sizes and SHA-256 hashes. Intermediate files stay under
`third_party/opencv/.build/`. The script never silently replaces a cached source
archive whose hash differs from the pin.

## Build Profile

The initial profile is deliberately conservative:

- WebAssembly + SIMD
- Single-threaded, so no `SharedArrayBuffer` or cross-origin isolation required
- Separate `.mjs` and `.wasm` files
- Modules: `core`, `imgproc`, `photo`, `js`
- Small JavaScript binding whitelist in `opencv_js.config.py`
- No DNN and no contrib modules

The generated module is intended for lazy loading through
`src/opencvRuntime.js`. Missing custom artifacts fall back to the pinned npm
runtime. Unsupported SIMD, initialization timeouts, and incomplete bindings
become structured unavailable results rather than uncaught editor failures.

## Checks

The loader contract, clean-clone fallback, timeout behavior, and ES-module
worker path can be tested without compiling OpenCV:

```bash
node scripts/opencv/check-runtime.mjs
```

After a full build the same command loads the real runtime and checks the
baseline bindings.

## Known Boundary

OpenCV 5's official JS whitelist includes the core features needed for contours,
distance transforms, GrabCut, inpainting, and Intelligent Scissors. It does not
currently expose `ximgproc.guidedFilter` in this build. Guided filtering needs a
separate binding feasibility pass before `opencv_contrib` is enabled.
