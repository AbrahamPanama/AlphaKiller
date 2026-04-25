import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const modelArg = readArg("--model") || process.env.ALPHAKILLER_BG_MODEL || "rmbg-1.4";
const sizeArg = readArg("--sizes");
const SIZES = sizeArg ? sizeArg.split(",").map((value) => Number(value.trim())).filter(Boolean) : [512, 1024, 2048];
const MODELS = modelArg === "all" ? ["rmbg-1.4", "ben2"] : [modelArg];
const TIMEOUT_MS = process.env.BG_REMOVE_SMOKE_TIMEOUT_MS || "300000";

for (const model of MODELS) {
  console.log(`\nmodel ${model}`);
  for (const size of SIZES) {
    const startedAt = performance.now();
    console.log(`\n${size}x${size}`);
    await runSmoke(size, model);
    console.log(`total ${(performance.now() - startedAt).toFixed(1)}ms`);
  }
}

function runSmoke(size, model) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/bg-remove-smoke.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        ALPHAKILLER_BG_MODEL: model,
        BG_REMOVE_SMOKE_SIZE: String(size),
        BG_REMOVE_SMOKE_TIMEOUT_MS: TIMEOUT_MS
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Background-removal benchmark failed for ${size}x${size} with code ${code}.\n${output}`));
      }
    });
  });
}

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  return args[index + 1] || "";
}
