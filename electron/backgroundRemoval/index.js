import { removeBackgroundWithBriaApi } from "./briaApiProvider.js";

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

  throw new Error(`Unsupported background-removal provider: ${provider}`);
}
