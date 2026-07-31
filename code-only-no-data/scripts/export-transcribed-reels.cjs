const fs = require("fs");
const path = require("path");

const sourceHandle = String(process.argv[2] || "abvaidya").trim().toLowerCase();
const outputPath = path.resolve(
  process.argv[3] || `./${sourceHandle}-transcribed-export.json`
);
const storePath = path.resolve(process.argv[4] || "./data/store.json");

const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
const reels = Array.isArray(store.reels) ? store.reels : [];

const exported = reels.filter((reel) => {
  return (
    String(reel.sourceHandle || "").trim().toLowerCase() === sourceHandle &&
    String(reel.transcript || "").trim()
  );
});

fs.writeFileSync(
  outputPath,
  JSON.stringify(
    {
      reels: exported,
    },
    null,
    2
  )
);

console.log(
  JSON.stringify(
    {
      ok: true,
      sourceHandle,
      count: exported.length,
      outputPath,
    },
    null,
    2
  )
);
