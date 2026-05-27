import { bufferFromPngPayload, readPngDimensions } from "../backgroundRemoval/validateImagePayload.js";

const BRIA_INCREASE_RESOLUTION_URL = "https://engine.prod.bria-api.com/v2/image/edit/increase_resolution";
const MAX_BRIA_OUTPUT_EDGE = 8192;

export async function superScaleWithBriaApi({
  pngBytes,
  scale = 2,
  preserveAlpha = true,
  apiToken = "",
  signal
}) {
  const token = apiToken || process.env.BRIA_API_TOKEN || process.env.ALPHAKILLER_BRIA_API_TOKEN || "";
  if (!token.trim()) {
    throw new Error("Missing BRIA_API_TOKEN.");
  }

  const desiredIncrease = normalizeScale(scale);
  const bytes = bufferFromPngPayload(pngBytes);
  const inputDimensions = readPngDimensions(bytes);
  if (
    inputDimensions.width * desiredIncrease > MAX_BRIA_OUTPUT_EDGE ||
    inputDimensions.height * desiredIncrease > MAX_BRIA_OUTPUT_EDGE
  ) {
    throw new Error(`BRIA Increase Resolution supports output up to ${MAX_BRIA_OUTPUT_EDGE} x ${MAX_BRIA_OUTPUT_EDGE} pixels.`);
  }

  const startedAt = performance.now();

  const response = await fetch(BRIA_INCREASE_RESOLUTION_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      api_token: token.trim()
    },
    body: JSON.stringify({
      image: bytes.toString("base64"),
      preserve_alpha: preserveAlpha !== false,
      desired_increase: desiredIncrease,
      sync: true,
      visual_input_content_moderation: false,
      visual_output_content_moderation: false
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getBriaSuperScaleErrorMessage(response, payload));
  }

  const imageUrl = payload?.result?.image_url;
  if (!imageUrl) {
    throw new Error("BRIA response did not include result.image_url.");
  }

  const imageResponse = await fetch(imageUrl, { signal });
  if (!imageResponse.ok) {
    throw new Error(`Failed to download BRIA super-scale result image: HTTP ${imageResponse.status}.`);
  }

  const resultBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const { width, height } = readPngDimensions(resultBuffer);

  return {
    pngBytes: resultBuffer.buffer.slice(resultBuffer.byteOffset, resultBuffer.byteOffset + resultBuffer.byteLength),
    provider: "bria-api",
    width,
    height,
    scale: desiredIncrease,
    durationMs: Math.round(performance.now() - startedAt),
    requestId: payload?.request_id || ""
  };
}

function normalizeScale(scale) {
  const value = Number(scale);
  if (value === 2 || value === 4) return value;
  throw new Error("BRIA super scale supports 2x or 4x.");
}

function getBriaSuperScaleErrorMessage(response, payload) {
  const detail = payload?.message || payload?.error || payload?.detail;
  if (detail) return String(detail);
  if (response.status === 401 || response.status === 403) {
    return "BRIA API token was rejected or does not have access.";
  }
  if (response.status === 415) {
    return "BRIA rejected the input format. AlphaKiller expected normalized PNG input.";
  }
  if (response.status === 429) {
    return "BRIA rate limit reached. Try again later.";
  }
  return `BRIA increase_resolution failed with HTTP ${response.status}.`;
}
