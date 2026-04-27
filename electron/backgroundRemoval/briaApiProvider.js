import { bufferFromPngPayload, readPngDimensions } from "./validateImagePayload.js";

const BRIA_REMOVE_BG_URL = "https://engine.prod.bria-api.com/v2/image/edit/remove_background";

export async function removeBackgroundWithBriaApi({
  pngBytes,
  preserveAlpha = true,
  apiToken = "",
  signal
}) {
  const token = apiToken || process.env.BRIA_API_TOKEN || process.env.ALPHAKILLER_BRIA_API_TOKEN || "";
  if (!token.trim()) {
    throw new Error("Missing BRIA_API_TOKEN.");
  }

  const bytes = bufferFromPngPayload(pngBytes);
  const startedAt = performance.now();

  const response = await fetch(BRIA_REMOVE_BG_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      api_token: token.trim()
    },
    body: JSON.stringify({
      image: bytes.toString("base64"),
      preserve_alpha: preserveAlpha !== false,
      sync: true,
      visual_input_content_moderation: false,
      visual_output_content_moderation: false
    })
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(getBriaErrorMessage(response, payload));
  }

  const imageUrl = payload?.result?.image_url;
  if (!imageUrl) {
    throw new Error("BRIA response did not include result.image_url.");
  }

  const imageResponse = await fetch(imageUrl, { signal });
  if (!imageResponse.ok) {
    throw new Error(`Failed to download BRIA result image: HTTP ${imageResponse.status}.`);
  }

  const resultBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const { width, height } = readPngDimensions(resultBuffer);

  return {
    pngBytes: resultBuffer.buffer.slice(resultBuffer.byteOffset, resultBuffer.byteOffset + resultBuffer.byteLength),
    provider: "bria-api",
    width,
    height,
    durationMs: Math.round(performance.now() - startedAt),
    requestId: payload?.request_id || ""
  };
}

function getBriaErrorMessage(response, payload) {
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
  return `BRIA remove_background failed with HTTP ${response.status}.`;
}
