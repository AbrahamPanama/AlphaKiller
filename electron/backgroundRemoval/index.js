import { removeBackgroundWithBriaApi } from "./briaApiProvider.js";
import { removeBackgroundWithPhotoroomApi } from "./photoroomApiProvider.js";

export async function removeBackground({
  provider,
  pngBytes,
  preserveAlpha = true,
  apiToken = "",
  signal
}) {
  if (provider === "bria-api") {
    return removeBackgroundWithBriaApi({ pngBytes, preserveAlpha, apiToken, signal });
  }

  if (provider === "photoroom-api") {
    return removeBackgroundWithPhotoroomApi({ pngBytes, apiToken, signal });
  }

  throw new Error(`Unsupported background-removal provider: ${provider}`);
}
