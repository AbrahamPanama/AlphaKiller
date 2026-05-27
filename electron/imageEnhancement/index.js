import { superScaleWithBriaApi } from "./briaSuperScaleProvider.js";

export async function superScaleImage({
  provider,
  pngBytes,
  scale = 2,
  preserveAlpha = true,
  apiToken = "",
  signal
}) {
  if (provider === "bria-api") {
    return superScaleWithBriaApi({ pngBytes, scale, preserveAlpha, apiToken, signal });
  }

  throw new Error(`Unsupported super-scale provider: ${provider}`);
}
