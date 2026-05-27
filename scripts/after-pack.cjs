const fs = require("node:fs/promises");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const removed = await removeAppleDoubleFiles(context.appOutDir);
  if (removed > 0) {
    console.log(`[afterPack] removed ${removed} AppleDouble metadata file${removed === 1 ? "" : "s"}`);
  }
};

async function removeAppleDoubleFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let removed = 0;

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.name.startsWith("._")) {
      await fs.rm(entryPath, { force: true, recursive: true });
      removed += 1;
      return;
    }

    if (entry.isDirectory()) {
      removed += await removeAppleDoubleFiles(entryPath);
    }
  }));

  return removed;
}
