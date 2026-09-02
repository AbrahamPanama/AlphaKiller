# OpenCV 5 Runtime Foundation

AlphaKiller's OpenCV runtime is optional, lazy, and worker-safe. A clean clone
uses the exact `@techstark/opencv-js@5.0.0-release.1` package, which mirrors the
official OpenCV 5.0.0 JavaScript build. Vite keeps its roughly 15 MB payload in
a separate lazy chunk, so it is loaded only when a Smart Edge or Smart Pen job
needs it.

The repository also includes a reproducible custom-build recipe pinned to
OpenCV commit `40738fb16ceddb5fb3fea747585f7ce6abb0605b` and Emscripten 4.0.20.
When real custom artifacts replace the checked-in placeholders, the loader
prefers them automatically. Missing custom artifacts therefore never break a
clean clone or packaged release.

The foundation exposes capability flags for contours, labeled distance
transforms, GrabCut, inpainting, and Intelligent Scissors. It reports guided
filtering and DNN as unavailable because neither is included in the shipping
runtime profile.

Build and verification instructions live in `scripts/opencv/README.md`.
