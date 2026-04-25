const MODEL_ID = process.env.ALPHAKILLER_HF_MODEL ||
  process.env.HF_MODEL_ID ||
  "briaai/RMBG-1.4";
const token = process.env.ALPHAKILLER_HF_TOKEN ||
  process.env.HF_TOKEN ||
  process.env.HF_ACCESS_TOKEN ||
  "";

const headers = {};
if (token.trim()) {
  headers.Authorization = `Bearer ${token.trim()}`;
}

const response = await fetch(`https://huggingface.co/${MODEL_ID}/resolve/main/config.json`, {
  headers
});

if (response.ok) {
  console.log(`Access OK for ${MODEL_ID}.`);
  process.exit(0);
}

const errorCode = response.headers.get("x-error-code") || "none";
const text = await response.text().catch(() => "");
console.error(`Access failed for ${MODEL_ID}: ${response.status} ${response.statusText}`);
console.error(`Hugging Face error code: ${errorCode}`);
if (response.status === 401 || errorCode.toLowerCase() === "gatedrepo") {
  console.error("The token is missing, expired, lacks read permission, or belongs to an account without granted access.");
  console.error("Set ALPHAKILLER_HF_TOKEN, HF_TOKEN, or HF_ACCESS_TOKEN when probing gated models.");
} else if (text) {
  console.error(text.slice(0, 500));
}
process.exit(1);
