import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storePath = path.join(root, "data", "store.json");
const sqlitePath = path.join(root, "data", "creator-os.db");

function parseJsonSafe(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toArrayTimestampedTranscript(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => {
        if (typeof entry === "string") {
          const text = entry.trim();
          return text ? { time: `${index + 1}`, text } : null;
        }
        const text = String(entry?.text || entry?.transcript || entry?.line || "").trim();
        const time = String(entry?.time || entry?.timestamp || entry?.ts || `${index + 1}`).trim();
        return text ? { time, text } : null;
      })
      .filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\n+/)
      .map((line) => {
        const text = line.trim();
        if (!text) return null;
        const match = text.match(/^\[([^\]]+)\]\s*(.+)$/);
        if (!match) return null;
        return { time: match[1].trim(), text: match[2].trim() };
      })
      .filter(Boolean);
  }

  return [];
}

function normalizeReel(reel, fallbackHandle, fallbackName) {
  const timestampedTranscript = toArrayTimestampedTranscript(reel.timestampedTranscript);
  const transcript = String(reel.transcript || timestampedTranscript.map((item) => item.text).join("\n") || "");
  return {
    id: String(reel.id || ""),
    title: String(reel.title || "Untitled reel"),
    platform: String(reel.platform || "instagram"),
    pillar: String(reel.pillar || "General"),
    hook: String(reel.hook || "Question"),
    format: String(reel.format || "Short video"),
    postedAt: String(reel.postedAt || new Date().toISOString()),
    views: Number(reel.views || 0),
    likes: Number(reel.likes || 0),
    comments: Number(reel.comments || 0),
    shares: Number(reel.shares || 0),
    saves: Number(reel.saves || 0),
    retention: Number(reel.retention || 0),
    watchTime: Number(reel.watchTime || 0),
    followersGained: Number(reel.followersGained || 0),
    url: String(reel.url || ""),
    mediaUrl: String(reel.mediaUrl || ""),
    thumbnailUrl: String(reel.thumbnailUrl || ""),
    caption: String(reel.caption || ""),
    language: String(reel.language || ""),
    transcript,
    timestampedTranscript,
    transcriptSource: String(reel.transcriptSource || ""),
    scriptSummary: Array.isArray(reel.scriptSummary) ? reel.scriptSummary.map((item) => String(item || "").trim()).filter(Boolean) : [],
    sceneBreakdown: Array.isArray(reel.sceneBreakdown)
      ? reel.sceneBreakdown.map((item, index) => ({
          time: String(item?.time || `${index + 1}`),
          text: String(item?.text || "").trim(),
        })).filter((item) => item.text)
      : timestampedTranscript,
    audioType: String(reel.audioType || ""),
    tone: String(reel.tone || ""),
    productionType: String(reel.productionType || ""),
    cta: String(reel.cta || ""),
    analysisStatus: String(reel.analysisStatus || (timestampedTranscript.length || transcript ? "transcribed" : "")),
    analysisError: String(reel.analysisError || ""),
    analysisUpdatedAt: String(reel.analysisUpdatedAt || ""),
    analysisProvider: String(reel.analysisProvider || ""),
    sourceHandle: String(reel.sourceHandle || fallbackHandle || "").replace(/^@/, "").trim().toLowerCase(),
    collabLabel: String(reel.collabLabel || ""),
    sourceFollowers: Number(reel.sourceFollowers || 0),
    sourceName: String(reel.sourceName || fallbackName || fallbackHandle || ""),
    audioUrl: String(reel.audioUrl || ""),
    transcriptMode: String(reel.transcriptMode || ""),
  };
}

function pickCanonicalHandle(exportData) {
  const counts = new Map();
  for (const handle of exportData.handles || []) {
    const clean = String(handle || "").replace(/^@/, "").trim().toLowerCase();
    if (!clean) continue;
    counts.set(clean, (counts.get(clean) || 0) + 1);
  }
  for (const reel of exportData.reels || []) {
    const clean = String(reel.sourceHandle || "").replace(/^@/, "").trim().toLowerCase();
    if (!clean) continue;
    counts.set(clean, (counts.get(clean) || 0) + 3);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function mergeById(current, incoming) {
  const map = new Map(current.map((item) => [String(item.id), item]));
  for (const reel of incoming) {
    const currentItem = map.get(String(reel.id)) || {};
    map.set(String(reel.id), {
      ...currentItem,
      ...reel,
      transcript: reel.transcript || currentItem.transcript || "",
      timestampedTranscript: reel.timestampedTranscript?.length ? reel.timestampedTranscript : currentItem.timestampedTranscript || [],
      scriptSummary: reel.scriptSummary?.length ? reel.scriptSummary : currentItem.scriptSummary || [],
      sceneBreakdown: reel.sceneBreakdown?.length ? reel.sceneBreakdown : currentItem.sceneBreakdown || [],
    });
  }
  return [...map.values()];
}

function wrapRawExport(raw, fallbackHandle, fallbackName) {
  if (Array.isArray(raw)) {
    return {
      exportedAt: new Date().toISOString(),
      creator: fallbackName || fallbackHandle || "Imported competitor",
      handles: fallbackHandle ? [fallbackHandle] : [],
      reels: raw.map((reel) => ({
        ...reel,
        sourceHandle: String(reel.sourceHandle || "").trim().toLowerCase() === "unknown" ? fallbackHandle : reel.sourceHandle,
        sourceName: reel.sourceName || fallbackName || "",
      })),
    };
  }
  return raw;
}

async function main() {
  const inputPath = process.argv[2];
  const fallbackHandleArg = String(process.argv[3] || "").replace(/^@/, "").trim().toLowerCase();
  const fallbackNameArg = String(process.argv[4] || "").trim();
  if (!inputPath) {
    throw new Error("Usage: node scripts/sync-competitor-export.mjs <export-json-path> [handle] [name]");
  }

  const rawExport = parseJsonSafe(await readFile(inputPath, "utf8"), null);
  const exportData = wrapRawExport(rawExport, fallbackHandleArg, fallbackNameArg);
  const store = parseJsonSafe(await readFile(storePath, "utf8"), null);
  if (!exportData || !store) {
    throw new Error("Could not read export or store JSON.");
  }

  const canonicalHandle = pickCanonicalHandle(exportData);
  const aliases = [...new Set((exportData.handles || [])
    .map((item) => String(item || "").replace(/^@/, "").trim().toLowerCase())
    .filter(Boolean)
    .filter((item) => item !== canonicalHandle))];
  const creatorName = String(exportData.creator || fallbackNameArg || "Imported competitor").trim();

  const normalizedReels = (exportData.reels || []).map((reel) =>
    normalizeReel(
      reel,
      String(reel.sourceHandle || canonicalHandle).replace(/^@/, "").trim().toLowerCase(),
      creatorName,
    ),
  );

  const nextProfile = {
    handle: canonicalHandle,
    name: creatorName,
    angle: "Imported competitor",
    platform: "instagram",
    followers: 0,
    profileUrl: canonicalHandle ? `https://www.instagram.com/${canonicalHandle}/` : "",
    lastProfileScrapedAt: String(exportData.exportedAt || new Date().toISOString()),
    aliases,
  };

  const currentProfiles = Array.isArray(store.competitorProfiles) ? store.competitorProfiles : [];
  const profileMap = new Map(currentProfiles.map((profile) => [String(profile.handle || "").trim().toLowerCase(), profile]));
  profileMap.set(canonicalHandle, {
    ...(profileMap.get(canonicalHandle) || {}),
    ...nextProfile,
  });

  const nextStore = {
    ...store,
    meta: {
      ...(store.meta || {}),
      updatedAt: new Date().toISOString(),
    },
    competitorProfiles: [...profileMap.values()],
    competitorReels: mergeById(Array.isArray(store.competitorReels) ? store.competitorReels : [], normalizedReels),
  };

  const serialized = JSON.stringify(nextStore, null, 2);
  await writeFile(storePath, serialized);

  if (existsSync(sqlitePath)) {
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO app_store (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run("store", serialized, new Date().toISOString());
    db.close();
  }

  const transcriptCount = normalizedReels.filter((reel) => reel.timestampedTranscript.length || reel.transcript).length;
  console.log(JSON.stringify({
    ok: true,
    creator: creatorName,
    canonicalHandle,
    aliases,
    reelsImported: normalizedReels.length,
    reelsWithTranscript: transcriptCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
