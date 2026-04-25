import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIZES = [512, 1024, 2048];
const TIMEOUT_MS = process.env.BG_REMOVE_SMOKE_TIMEOUT_MS || "300000";

for (const size of SIZES) {
  const startedAt = performance.now();
  console.log(`\n${size}x${size}`);
  await runSmoke(size);
  console.log(`total ${(performance.now() - startedAt).toFixed(1)}ms`);
}

function runSmoke(size) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/bg-remove-smoke.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
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
