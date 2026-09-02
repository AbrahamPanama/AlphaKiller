// Clean-clone placeholder. scripts/opencv/build-opencv5.sh replaces this file
// with the pinned Emscripten output. The runtime manifest prevents normal code
// from importing this placeholder.
export default async function createMissingOpenCvModule() {
  const error = new Error(
    "The pinned OpenCV 5 runtime has not been built. Run scripts/opencv/build-opencv5.sh."
  );
  error.code = "OPENCV_ARTIFACTS_MISSING";
  throw error;
}
