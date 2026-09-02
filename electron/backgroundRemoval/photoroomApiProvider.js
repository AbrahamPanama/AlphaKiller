import { bufferFromPngPayload, readPngDimensions } from "./validateImagePayload.js";

const PHOTOROOM_SEGMENT_URL = "https://sdk.photoroom.com/v1/segment";
const MAX_PHOTOROOM_EDGE = 6000;
const MAX_PHOTOROOM_PIXELS = 36_000_000;

export async function removeBackgroundWithPhotoroomApi({
  pngBytes,
  apiToken = "",
  signal,
  fetchImpl = fetch
}) {
  const token = apiToken ||
    process.env.PHOTOROOM_API_KEY ||
    process.env.ALPHAKILLER_PHOTOROOM_API_KEY ||
    "";

  if (!token.trim()) {
    throw new Error("Missing PHOTOROOM_API_KEY.");
  }

  const bytes = bufferFromPngPayload(pngBytes);
  const inputDimensions = readPngDimensions(bytes);
  validatePhotoroomDimensions(inputDimensions);

  const form = new FormData();
  form.append("image_file", new Blob([bytes], { type: "image/png" }), "alphakiller-input.png");
  form.append("format", "png");
  form.append("channels", "rgba");
  form.append("size", "full");
  form.append("crop", "false");

  const startedAt = performance.now();
  const response = await fetchImpl(PHOTOROOM_SEGMENT_URL, {
    method: "POST",
    signal,
    headers: {
      "x-api-key": token.trim()
    },
    body: form
  });

  if (!response.ok) {
    throw new Error(await getPhotoroomErrorMessage(response));
  }

  const resultBuffer = Buffer.from(await response.arrayBuffer());
  let outputDimensions;
  try {
    outputDimensions = readPngDimensions(resultBuffer);
  } catch {
    throw new Error("PhotoRoom returned an invalid PNG response.");
  }

  if (
    outputDimensions.width !== inputDimensions.width ||
    outputDimensions.height !== inputDimensions.height
  ) {
    throw new Error(
      `PhotoRoom returned ${outputDimensions.width} x ${outputDimensions.height}, ` +
      `but AlphaKiller sent ${inputDimensions.width} x ${inputDimensions.height}.`
    );
  }

  return {
    pngBytes: resultBuffer.buffer.slice(
      resultBuffer.byteOffset,
      resultBuffer.byteOffset + resultBuffer.byteLength
    ),
    provider: "photoroom-api",
    width: outputDimensions.width,
    height: outputDimensions.height,
    durationMs: Math.round(performance.now() - startedAt),
    requestId: response.headers.get("x-request-id") || ""
  };
}

function validatePhotoroomDimensions({ width, height }) {
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_PHOTOROOM_EDGE ||
    height > MAX_PHOTOROOM_EDGE ||
    width * height > MAX_PHOTOROOM_PIXELS
  ) {
    throw new Error(
      "PhotoRoom supports images up to 6,000 pixels on either side and 36 megapixels."
    );
  }
}

async function getPhotoroomErrorMessage(response) {
  const payload = await readErrorPayload(response);
  const detail = payload?.message || payload?.error || payload?.detail;
  if (detail) return String(detail);

  if (response.status === 401 || response.status === 403) {
    return "PhotoRoom API key was rejected or does not have access.";
  }
  if (response.status === 413) {
    return "PhotoRoom rejected the image because it is too large.";
  }
  if (response.status === 415) {
    return "PhotoRoom rejected the input format. AlphaKiller expected normalized PNG input.";
  }
  if (response.status === 429) {
    return "PhotoRoom rate limit reached. Try again later.";
  }
  if (response.status >= 500) {
    return "PhotoRoom is temporarily unavailable. Try again later.";
  }
  return `PhotoRoom background removal failed with HTTP ${response.status}.`;
}

async function readErrorPayload(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}
