const fs = require("fs");
const path = require("path");

function usage() {
  console.error(
    "Usage: node scripts/merge-reels-into-store.cjs <import-file> [store-file]"
  );
  process.exit(1);
}

const importArg = process.argv[2];
if (!importArg) usage();

const importPath = path.resolve(importArg);
const storePath = path.resolve(
  process.argv[3] || "/var/www/content-creator/data/store.json"
);

const imported = JSON.parse(fs.readFileSync(importPath, "utf8"));
const store = JSON.parse(fs.readFileSync(storePath, "utf8"));

const incoming = Array.isArray(imported)
  ? imported
  : Array.isArray(imported.reels)
    ? imported.reels
    : [];

if (!incoming.length) {
  console.error("No reels found in import file.");
  process.exit(1);
}

const existing = Array.isArray(store.reels) ? store.reels : [];
const mergedById = new Map(existing.map((reel) => [String(reel.id), reel]));

for (const reel of incoming) {
  const reelId = String(reel.id || "");
  if (!reelId) continue;
  const current = mergedById.get(reelId) || {};
  mergedById.set(reelId, { ...current, ...reel });
}

store.reels = Array.from(mergedById.values());
store.meta = {
  ...(store.meta || {}),
  updatedAt: new Date().toISOString(),
};

fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

console.log(
  JSON.stringify(
    {
      ok: true,
      imported: incoming.length,
      totalReels: store.reels.length,
      storePath,
    },
    null,
    2
  )
);
