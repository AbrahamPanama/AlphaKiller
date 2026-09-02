import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function readArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null) {
      throw new Error(`Invalid argument near ${name ?? "<end>"}`);
    }
    result[name.slice(2)] = value;
  }
  return result;
}

async function describeArtifact(filePath) {
  const bytes = await readFile(filePath);
  return {
    file: path.basename(filePath),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

const args = readArguments(process.argv.slice(2));
const required = [
  "output",
  "module",
  "wasm",
  "opencv-version",
  "opencv-commit",
  "emscripten-version",
  "emscripten-image",
  "profile"
];

for (const name of required) {
  if (!args[name]) {
    throw new Error(`Missing --${name}`);
  }
}

const manifest = {
  schemaVersion: 1,
  status: "ready",
  opencv: {
    version: args["opencv-version"],
    commit: args["opencv-commit"],
    repository: "https://github.com/opencv/opencv"
  },
  toolchain: {
    emscriptenVersion: args["emscripten-version"],
    containerImage: args["emscripten-image"]
  },
  build: {
    profile: args.profile,
    simd: true,
    threads: false,
    modules: ["core", "imgproc", "photo", "js"],
    generatedAt: new Date().toISOString()
  },
  artifacts: {
    module: await describeArtifact(args.module),
    wasm: await describeArtifact(args.wasm)
  }
};

await writeFile(args.output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${args.output}`);
