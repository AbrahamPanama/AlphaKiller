#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=versions.env
source "$SCRIPT_DIR/versions.env"

MODE="auto"
SOURCE_ONLY=0

usage() {
  cat <<'EOF'
Usage: scripts/opencv/build-opencv5.sh [--docker | --local] [--source-only]

Downloads the pinned official OpenCV source archive, verifies its SHA-256,
and builds AlphaKiller's non-threaded SIMD OpenCV 5 ES-module runtime.

  --docker       Require the pinned Emscripten container (recommended).
  --local        Require a locally activated, exact Emscripten toolchain.
  --source-only  Download and verify source without compiling it.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --docker) MODE="docker" ;;
    --local) MODE="local" ;;
    --source-only) SOURCE_ONLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

WORK_ROOT="$PROJECT_ROOT/third_party/opencv/.build"
DOWNLOAD_DIR="$WORK_ROOT/downloads"
SOURCE_PARENT="$WORK_ROOT/sources"
SOURCE_DIR="$SOURCE_PARENT/opencv-$OPENCV_COMMIT"
BUILD_DIR="$WORK_ROOT/build-$OPENCV_VERSION-$OPENCV_BUILD_PROFILE"
OUTPUT_DIR="$PROJECT_ROOT/third_party/opencv/$OPENCV_VERSION"
ARCHIVE="$DOWNLOAD_DIR/opencv-$OPENCV_COMMIT.tar.gz"
ARCHIVE_URL="https://github.com/opencv/opencv/archive/$OPENCV_COMMIT.tar.gz"

mkdir -p "$DOWNLOAD_DIR" "$SOURCE_PARENT" "$OUTPUT_DIR"

verify_sha256() {
  local file_path="$1"
  local expected="$2"
  local actual
  actual="$(shasum -a 256 "$file_path" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    printf 'SHA-256 mismatch for %s\nexpected: %s\nactual:   %s\n' "$file_path" "$expected" "$actual" >&2
    exit 1
  fi
}

if [[ ! -f "$ARCHIVE" ]]; then
  temporary_archive="$ARCHIVE.part.$$"
  printf 'Downloading OpenCV %s from the official repository...\n' "$OPENCV_VERSION"
  curl -fL --retry 3 --retry-delay 2 -o "$temporary_archive" "$ARCHIVE_URL"
  verify_sha256 "$temporary_archive" "$OPENCV_ARCHIVE_SHA256"
  mv "$temporary_archive" "$ARCHIVE"
else
  printf 'Using cached source archive %s\n' "$ARCHIVE"
  verify_sha256 "$ARCHIVE" "$OPENCV_ARCHIVE_SHA256"
fi

if [[ ! -f "$SOURCE_DIR/CMakeLists.txt" ]]; then
  printf 'Extracting pinned source commit %s...\n' "$OPENCV_COMMIT"
  tar -xzf "$ARCHIVE" -C "$SOURCE_PARENT"
fi

if [[ ! -f "$SOURCE_DIR/CMakeLists.txt" ]]; then
  printf 'OpenCV source extraction did not produce %s\n' "$SOURCE_DIR" >&2
  exit 1
fi

if (( SOURCE_ONLY != 0 )); then
  printf 'Pinned source is ready at %s\n' "$SOURCE_DIR"
  exit 0
fi

if [[ "$MODE" == "auto" ]]; then
  if command -v docker >/dev/null 2>&1; then
    MODE="docker"
  else
    MODE="local"
  fi
fi

BUILD_FLAGS="-Os -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker -s ASSERTIONS=0"
CONFIG_PATH="$SCRIPT_DIR/opencv_js.config.py"

run_build() {
  local source_path="$1"
  local build_path="$2"
  local config_path="$3"
  emcmake python3 "$source_path/platforms/js/build_js.py" "$build_path" \
    --opencv_dir "$source_path" \
    --build_wasm \
    --simd \
    --disable_single_file \
    --config "$config_path" \
    --build_flags="$BUILD_FLAGS" \
    --cmake_option="-DCMAKE_CXX_STANDARD=17" \
    --cmake_option="-DBUILD_LIST=core,imgproc,photo,js"
}

if [[ "$MODE" == "docker" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is required for --docker mode.\n' >&2
    exit 1
  fi

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --volume "$PROJECT_ROOT:/workspace" \
    --workdir /workspace \
    "$EMSCRIPTEN_IMAGE" \
    bash -lc "$(declare -f run_build); BUILD_FLAGS='$BUILD_FLAGS'; run_build '/workspace/${SOURCE_DIR#"$PROJECT_ROOT/"}' '/workspace/${BUILD_DIR#"$PROJECT_ROOT/"}' '/workspace/${CONFIG_PATH#"$PROJECT_ROOT/"}'"
elif [[ "$MODE" == "local" ]]; then
  for command_name in emcmake emcc cmake python3; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      printf '%s is required for --local mode. Activate emsdk %s first.\n' "$command_name" "$EMSCRIPTEN_VERSION" >&2
      exit 1
    fi
  done
  detected_emcc="$(emcc --version | head -n 1)"
  if [[ "$detected_emcc" != *"$EMSCRIPTEN_VERSION"* ]]; then
    printf 'Expected Emscripten %s, found: %s\n' "$EMSCRIPTEN_VERSION" "$detected_emcc" >&2
    exit 1
  fi
  run_build "$SOURCE_DIR" "$BUILD_DIR" "$CONFIG_PATH"
else
  printf 'Unsupported build mode: %s\n' "$MODE" >&2
  exit 2
fi

RAW_MODULE="$BUILD_DIR/bin/opencv_js.js"
RAW_WASM="$BUILD_DIR/bin/opencv_js.wasm"

if [[ ! -f "$RAW_MODULE" || ! -f "$RAW_WASM" ]]; then
  printf 'Expected ES-module artifacts were not produced in %s/bin\n' "$BUILD_DIR" >&2
  exit 1
fi

if ! grep -q "export default" "$RAW_MODULE"; then
  printf 'The generated OpenCV glue is not an ES module. Refusing to package it.\n' >&2
  exit 1
fi

install -m 0644 "$RAW_MODULE" "$OUTPUT_DIR/opencv.mjs"
install -m 0644 "$RAW_WASM" "$OUTPUT_DIR/opencv.wasm"
install -m 0644 "$SOURCE_DIR/LICENSE" "$OUTPUT_DIR/LICENSE.opencv.txt"

node "$SCRIPT_DIR/write-runtime-manifest.mjs" \
  --output "$OUTPUT_DIR/runtime-manifest.json" \
  --module "$OUTPUT_DIR/opencv.mjs" \
  --wasm "$OUTPUT_DIR/opencv.wasm" \
  --opencv-version "$OPENCV_VERSION" \
  --opencv-commit "$OPENCV_COMMIT" \
  --emscripten-version "$EMSCRIPTEN_VERSION" \
  --emscripten-image "$EMSCRIPTEN_IMAGE" \
  --profile "$OPENCV_BUILD_PROFILE"

printf '\nOpenCV runtime is ready in %s\n' "$OUTPUT_DIR"
printf 'Run: node scripts/opencv/check-runtime.mjs\n'
