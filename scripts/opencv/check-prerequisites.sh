#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$SCRIPT_DIR/versions.env"

missing=0

check_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    printf 'ok      %-12s %s\n' "$command_name" "$(command -v "$command_name")"
  else
    printf 'missing %-12s\n' "$command_name"
    missing=1
  fi
}

printf 'AlphaKiller OpenCV %s build prerequisites\n' "$OPENCV_VERSION"
printf 'Build profile: %s\n\n' "$OPENCV_BUILD_PROFILE"

check_command git
check_command curl
check_command python3
check_command shasum
check_command node

printf '\nBuild backend (one is required):\n'
if command -v docker >/dev/null 2>&1; then
  printf 'ok      docker       %s\n' "$(docker --version 2>/dev/null || command -v docker)"
  printf '        image        %s\n' "$EMSCRIPTEN_IMAGE"
elif command -v emcmake >/dev/null 2>&1 && command -v emcc >/dev/null 2>&1 && command -v cmake >/dev/null 2>&1; then
  detected="$(emcc --version | head -n 1)"
  printf 'ok      local emsdk  %s\n' "$detected"
  if [[ "$detected" != *"$EMSCRIPTEN_VERSION"* ]]; then
    printf 'error   expected Emscripten %s exactly\n' "$EMSCRIPTEN_VERSION"
    missing=1
  fi
else
  printf 'missing docker, or the local emcmake + emcc + cmake toolchain\n'
  missing=1
fi

if (( missing != 0 )); then
  printf '\nPrerequisites are incomplete. See scripts/opencv/README.md.\n' >&2
  exit 1
fi

printf '\nPrerequisites are ready.\n'
