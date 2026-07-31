import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, ".env");

function loadEnvFile(filePath) {
  try {
    const source = readFileSync(filePath, "utf8");
    source.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) return;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    });
  } catch {
    // Ignore missing .env files and keep relying on the real environment.
  }
}

loadEnvFile(envPath);

const dataDir = path.join(root, "data");
const storePath = path.join(dataDir, "store.json");
const sqlitePath = path.join(dataDir, "creator-os.db");
const publicFiles = new Set(["index.html", "app.css", "app.js"]);
const port = Number(process.env.PORT || 8787);
const adminToken = process.env.ADMIN_TOKEN || "";
const adminUsername = process.env.ADMIN_USERNAME || "";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const openAiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const openAiTranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const newsLookbackDays = Math.max(1, Math.min(365, Number(process.env.NEWS_LOOKBACK_DAYS || 30)));
const newsQueryLimit = Math.max(5, Math.min(40, Number(process.env.NEWS_QUERY_LIMIT || 20)));
const apifyAutoImportEnabledEnv = String(process.env.APIFY_AUTO_IMPORT_ENABLED || "").toLowerCase() === "true";
const apifyAutoImportIntervalMinutesEnv = Math.max(15, Number(process.env.APIFY_AUTO_IMPORT_INTERVAL_MINUTES || 180));
const apifyAutoImportUsernameEnv = String(process.env.APIFY_AUTO_IMPORT_USERNAME || "").replace(/^@/, "").trim().toLowerCase();
const apifyAutoImportResultsLimitEnv = Math.max(1, Math.min(10, Number(process.env.APIFY_AUTO_IMPORT_RESULTS_LIMIT || 3)));
const transcriptionProvider = (process.env.TRANSCRIPTION_PROVIDER || "openai").toLowerCase();
const localTranscriptionPython = process.env.LOCAL_TRANSCRIPTION_PYTHON || "python";
const localWhisperModel = process.env.LOCAL_WHISPER_MODEL || "small";
const localWhisperComputeType = process.env.LOCAL_WHISPER_COMPUTE_TYPE || "int8";
const localWhisperDevice = process.env.LOCAL_WHISPER_DEVICE || "auto";
const localWhisperLanguage = process.env.LOCAL_WHISPER_LANGUAGE || "";
const chatProvider = (process.env.CHAT_PROVIDER || "").toLowerCase();
const rateBucket = new Map();
const dashboardDecorCache = new Map();
let apifyAutoImportTimer = null;
let apifyAutoImportInFlight = false;
const db = new DatabaseSync(sqlitePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const contentType = (filePath) => {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 1) => Number(value.toFixed(digits));
const sum = (items, key) => items.reduce((total, item) => total + Number(item[key] || 0), 0);
const avg = (items, key) => (items.length ? sum(items, key) / items.length : 0);
const fmtCompact = (value) =>
  new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const fmtPercent = (value, digits = 1) => `${round(value, digits)}%`;
const fmtSignedPercent = (value, digits = 0) => `${value >= 0 ? "+" : ""}${round(value, digits)}%`;

const now = () => new Date();
const startOfDay = (date) => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
};
const dateKey = (date) => startOfDay(date).toISOString().slice(0, 10);
const daysAgo = (count) => {
  const result = now();
  result.setDate(result.getDate() - count);
  result.setHours(0, 0, 0, 0);
  return result;
};
const parseJson = (value, fallback = {}) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
const titleCase = (value) =>
  String(value || "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

function emptyStore() {
  return normalizeStore({
    meta: { updatedAt: new Date().toISOString() },
    creator: {
      name: "",
      niche: ""
    },
    branding: {
      title: "",
      subtitle: ""
    },
    reels: [],
    competitors: [],
    competitorProfiles: [],
    competitorReels: [],
    news: [],
    assistant: {
      threads: [],
      pinned: []
    },
    integrations: {
      apify: {
        mode: "actor",
        actorId: "",
        profileActorId: "apify~instagram-profile-scraper",
        taskId: "",
        token: "",
        input: {},
        autoImportEnabled: false,
        autoImportIntervalMinutes: 60,
        autoImportUsername: "",
        autoImportResultsLimit: 3,
        lastAutoImportAt: "",
        lastAutoImportStatus: ""
      },
      brightData: {
        datasetId: "",
        input: []
      },
      news: {
        lastLiveRunAt: "",
        lastSource: "",
        queries: []
      },
      winster: {
        enabled: false,
        baseUrl: "",
        apiKey: "",
        model: "",
        path: "/chat"
      }
    }
  });
}

function normalizeStore(store) {
  return {
    ...store,
    competitorProfiles: Array.isArray(store.competitorProfiles) ? store.competitorProfiles.map(normalizeCompetitorProfile) : [],
    competitorReels: Array.isArray(store.competitorReels) ? store.competitorReels.map(normalizeReel) : [],
    assistant: {
      threads: Array.isArray(store.assistant?.threads) ? store.assistant.threads.map(normalizeAssistantThread) : [],
      pinned: Array.isArray(store.assistant?.pinned) ? store.assistant.pinned.map(normalizePinnedMessage) : []
    },
    integrations: {
      apify: {
        mode: "actor",
        actorId: "",
        profileActorId: "apify~instagram-profile-scraper",
        taskId: "",
        token: "",
        input: {},
        autoImportEnabled: false,
        autoImportIntervalMinutes: 60,
        autoImportUsername: "",
        autoImportResultsLimit: 3,
        lastAutoImportAt: "",
        lastAutoImportStatus: "",
        ...(store.integrations?.apify || {})
      },
      brightData: {
        datasetId: "",
        input: [],
        ...(store.integrations?.brightData || {})
      },
      news: {
        lastLiveRunAt: "",
        lastSource: "",
        queries: [],
        ...(store.integrations?.news || {})
      },
      winster: {
        enabled: false,
        baseUrl: "",
        apiKey: "",
        model: "",
        path: "/chat",
        ...(store.integrations?.winster || {})
      }
    }
  };
}

function normalizeAssistantMessage(message) {
  return {
    role: message?.role === "user" ? "user" : "assistant",
    text: String(message?.text || ""),
    tone: String(message?.tone || ""),
    citations: Array.isArray(message?.citations)
      ? message.citations.map((citation) => ({
          label: String(citation?.label || ""),
          view: String(citation?.view || ""),
          section: String(citation?.section || "")
        }))
      : []
  };
}

function normalizeAssistantThread(thread) {
  return {
    id: String(thread?.id || `thread-${Math.random().toString(36).slice(2, 8)}`),
    title: String(thread?.title || "New chat"),
    updatedAt: String(thread?.updatedAt || new Date().toISOString()),
    messages: Array.isArray(thread?.messages) ? thread.messages.map(normalizeAssistantMessage) : [],
    storyContext: normalizeChatStoryContext(thread?.storyContext)
  };
}

function normalizePinnedMessage(item) {
  return {
    id: String(item?.id || `pin-${Math.random().toString(36).slice(2, 8)}`),
    text: String(item?.text || ""),
    threadId: String(item?.threadId || ""),
    title: String(item?.title || "Pinned takeaway")
  };
}

function sanitizeAssistantPatch(patch, currentAssistant) {
  return {
    threads: Array.isArray(patch?.threads)
      ? patch.threads.map(normalizeAssistantThread).slice(0, 20)
      : currentAssistant.threads.map(normalizeAssistantThread),
    pinned: Array.isArray(patch?.pinned)
      ? patch.pinned.map(normalizePinnedMessage).slice(0, 12)
      : currentAssistant.pinned.map(normalizePinnedMessage)
  };
}

function pickValue(item, keys, fallback = "") {
  for (const key of keys) {
    const parts = key.split(".");
    let current = item;
    for (const part of parts) current = current?.[part];
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return fallback;
}

function normalizePlatform(value) {
  const platform = String(value || "instagram").toLowerCase();
  if (platform.includes("youtube")) return "youtube";
  if (platform.includes("linkedin")) return "linkedin";
  if (platform.includes("twitter") || platform === "x") return "x";
  return "instagram";
}

function deriveReelTitle(item) {
  const caption = String(pickValue(item, ["title", "caption", "text", "description", "postText"], "Imported reel"));
  return caption.length > 120 ? `${caption.slice(0, 117)}...` : caption;
}

function deriveHook(item) {
  return pickValue(item, ["hook", "opening", "hookType", "contentDetails.hook", "analysis.hook"], "Question");
}

async function readStore() {
  const row = db.prepare("SELECT value FROM app_store WHERE key = ?").get("store");
  if (row?.value) {
    const parsed = parseJson(row.value);
    const normalized = normalizeStore(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) await writeStore(normalized);
    return normalized;
  }
  let initial = null;
  try {
    initial = normalizeStore(parseJson(await readFile(storePath, "utf8")));
  } catch {
    initial = emptyStore();
  }
  await writeStore(initial);
  return initial;
}

async function writeStore(store) {
  const serialized = JSON.stringify(normalizeStore(store), null, 2);
  db.prepare(`
    INSERT INTO app_store (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run("store", serialized, new Date().toISOString());
  await writeFile(storePath, serialized);
}

async function collectBody(request) {
  const parts = [];
  for await (const chunk of request) parts.push(chunk);
  return Buffer.concat(parts).toString("utf8");
}

function replyJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function serveFile(response, filePath) {
  try {
    const source = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache"
    });
    response.end(source);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function unauthorized(response) {
  replyJson(response, 401, { error: "Invalid admin token." });
}

function forbidden(response, message = "Admin environment is not configured.") {
  replyJson(response, 503, { error: message });
}

function clientIp(request) {
  return String(
    request.headers["x-forwarded-for"] ||
    request.socket?.remoteAddress ||
    "local"
  ).split(",")[0].trim();
}

function isRateLimited(request, scope, limit, windowMs) {
  const key = `${scope}:${clientIp(request)}`;
  const current = Date.now();
  const bucket = rateBucket.get(key);
  if (!bucket || current > bucket.resetAt) {
    rateBucket.set(key, { count: 1, resetAt: current + windowMs });
    return false;
  }
  bucket.count += 1;
  if (bucket.count > limit) return true;
  return false;
}

function matchesBasicAuth(request) {
  if (!adminUsername || !adminPassword) return false;
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const [username, password] = decoded.split(":");
    return username === adminUsername && password === adminPassword;
  } catch {
    return false;
  }
}

function requireAdmin(request, response) {
  if (!adminToken && !(adminUsername && adminPassword)) {
    forbidden(response, "Set ADMIN_TOKEN or ADMIN_USERNAME and ADMIN_PASSWORD in the environment.");
    return false;
  }
  if (isRateLimited(request, "admin", 60, 60_000)) {
    replyJson(response, 429, { error: "Too many admin requests. Try again shortly." });
    return false;
  }
  const token = String(request.headers["x-admin-token"] || "");
  const tokenMatches = adminToken && token === adminToken;
  const basicMatches = matchesBasicAuth(request);
  if (!tokenMatches && !basicMatches) {
    unauthorized(response);
    return false;
  }
  return true;
}

function secureSecretStatus(value) {
  return value ? "configured" : "missing";
}

function publicStore(store) {
  const apify = apifyConfig(store);
  const brightData = brightDataConfig(store);
  const winster = winsterConfig(store);
  return {
    ...store,
    competitorProfiles: (store.competitorProfiles || []).map(normalizeCompetitorProfile),
    competitorReels: (store.competitorReels || []).map(normalizeReel),
    integrations: {
      ...store.integrations,
      apify: {
        ...store.integrations?.apify,
        mode: apify.mode,
        actorId: apify.actorId,
        profileActorId: apify.profileActorId,
        taskId: apify.taskId,
        input: apify.input,
        autoImportEnabled: apify.autoImportEnabled,
        autoImportIntervalMinutes: apify.autoImportIntervalMinutes,
        autoImportUsername: apify.autoImportUsername,
        autoImportResultsLimit: apify.autoImportResultsLimit,
        lastAutoImportAt: apify.lastAutoImportAt,
        lastAutoImportStatus: apify.lastAutoImportStatus,
        token: "",
        tokenStatus: secureSecretStatus(apify.token)
      },
      brightData: {
        ...store.integrations?.brightData,
        datasetId: brightData.datasetId,
        input: brightData.input,
        apiKey: "",
        apiKeyStatus: secureSecretStatus(brightData.apiKey)
      },
      news: {
        ...store.integrations?.news
      },
      winster: {
        ...store.integrations?.winster,
        enabled: winster.enabled,
        baseUrl: winster.baseUrl,
        model: winster.model,
        path: winster.path,
        apiKey: "",
        apiKeyStatus: secureSecretStatus(winster.apiKey)
      }
    }
  };
}

function normalizeTimestampedTranscript(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => {
        if (typeof entry === "string") {
          const text = entry.trim();
          return text ? { time: `${index + 1}`, text } : null;
        }
        const start = entry?.start ?? entry?.startTime ?? entry?.from;
        const end = entry?.end ?? entry?.endTime ?? entry?.to;
        const derivedTime = [start, end].filter((item) => item !== undefined && item !== null && String(item).trim()).join("-");
        const time = String(entry?.time || entry?.timestamp || entry?.ts || derivedTime || `${index + 1}`);
        const text = String(entry?.text || entry?.transcript || entry?.line || entry?.content || entry?.caption || "").trim();
        return text ? { time, text } : null;
      })
      .filter(Boolean);
  }

  if (value && typeof value === "object") {
    if (Array.isArray(value.segments)) return normalizeTimestampedTranscript(value.segments);
    if (Array.isArray(value.items)) return normalizeTimestampedTranscript(value.items);
  }

  if (typeof value === "string" && value.trim()) {
    try {
      return normalizeTimestampedTranscript(JSON.parse(value));
    } catch {
      return value
        .split(/\n+/)
        .map((line, index) => {
          const text = line.trim();
          if (!text) return null;
          const match = text.match(/^\[([^\]]+)\]\s*(.+)$/);
          if (match) {
            return {
              time: match[1].trim(),
              text: match[2].trim(),
            };
          }
          return text ? { time: `${index + 1}`, text } : null;
        })
        .filter(Boolean);
    }
  }

  return [];
}

function normalizeReel(reel) {
  const timestampedTranscript = normalizeTimestampedTranscript(
    reel.timestampedTranscript || reel.timestamped_transcript || reel.transcriptSegments || reel.segments,
  );
  const sceneBreakdown = Array.isArray(reel.sceneBreakdown)
    ? reel.sceneBreakdown.map((scene, index) => ({
        time: String(scene?.time || `${index + 1}`),
        text: String(scene?.text || "")
      }))
    : timestampedTranscript;
  const scriptSummary = Array.isArray(reel.scriptSummary)
    ? reel.scriptSummary.map((line) => String(line || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  const transcript = String(reel.transcript || timestampedTranscript.map((segment) => segment.text).join("\n") || "");
  return {
    id: String(reel.id || `reel-${Math.random().toString(36).slice(2, 8)}`),
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
    url: String(reel.url || reel.permalink || ""),
    mediaUrl: String(reel.mediaUrl || reel.videoUrl || reel.downloadUrl || ""),
    thumbnailUrl: String(reel.thumbnailUrl || reel.coverUrl || reel.displayUrl || ""),
    caption: String(reel.caption || ""),
    language: String(reel.language || ""),
    transcript,
    timestampedTranscript,
    transcriptSource: String(reel.transcriptSource || ""),
    scriptSummary,
    sceneBreakdown,
    audioType: String(reel.audioType || ""),
    tone: String(reel.tone || ""),
    productionType: String(reel.productionType || ""),
    cta: String(reel.cta || ""),
    analysisStatus: String(reel.analysisStatus || ""),
    analysisError: String(reel.analysisError || ""),
    analysisUpdatedAt: String(reel.analysisUpdatedAt || ""),
    analysisProvider: String(reel.analysisProvider || ""),
    sourceHandle: String(reel.sourceHandle || ""),
    collabLabel: String(reel.collabLabel || ""),
    sourceFollowers: Number(reel.sourceFollowers || 0),
    sourceName: String(reel.sourceName || "")
  };
}

function hasTranscriptPayload(reel) {
  if (!reel) return false;
  if (normalizeTimestampedTranscript(reel.timestampedTranscript).length) return true;
  if (Array.isArray(reel.sceneBreakdown) && reel.sceneBreakdown.some((scene) => String(scene?.text || "").trim())) return true;
  if (Array.isArray(reel.scriptSummary) && reel.scriptSummary.some((line) => String(line || "").trim())) return true;
  if (String(reel.transcriptSource || "").trim()) return true;
  return Boolean(String(reel.transcript || "").trim());
}

function normalizeCompetitor(competitor) {
  return {
    name: String(competitor.name || "Unnamed competitor"),
    angle: String(competitor.angle || "Unknown"),
    canonicalHandle: String(competitor.canonicalHandle || "").replace(/^@/, "").trim().toLowerCase(),
    monthlyGrowth: Number(competitor.monthlyGrowth || 0),
    followers: Number(competitor.followers || 0),
    engagementRate: Number(competitor.engagementRate || 0),
    bestFormat: String(competitor.bestFormat || "Unknown"),
    warning: String(competitor.warning || "No note"),
    importedPosts: Number(competitor.importedPosts || 0),
    avgViewsSeed: Number(competitor.avgViewsSeed || 0),
    postsPerWeekSeed: Number(competitor.postsPerWeekSeed || 0),
    topHookSeed: String(competitor.topHookSeed || ""),
    reels: Array.isArray(competitor.reels) ? competitor.reels : []
  };
}

function normalizeCompetitorProfile(profile) {
  const aliases = Array.isArray(profile?.aliases)
    ? profile.aliases
    : String(profile?.aliases || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  return {
    handle: String(profile?.handle || "").replace(/^@/, "").trim().toLowerCase(),
    name: String(profile?.name || profile?.handle || "Unnamed competitor"),
    angle: String(profile?.angle || "Unknown angle"),
    platform: String(profile?.platform || "instagram"),
    followers: Number(profile?.followers || 0),
    profileUrl: String(profile?.profileUrl || ""),
    lastProfileScrapedAt: String(profile?.lastProfileScrapedAt || ""),
    aliases: aliases
      .map((value) => String(value || "").replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean)
  };
}

function normalizeNews(story) {
  return {
    id: String(story.id || `news-${Math.random().toString(36).slice(2, 8)}`),
    source: String(story.source || "Unknown"),
    headline: String(story.headline || "Untitled story"),
    summary: String(story.summary || ""),
    publishedAt: String(story.publishedAt || new Date().toISOString()),
    relevance: Number(story.relevance || 50),
    topic: String(story.topic || "Creator economy"),
    url: String(story.url || story.link || ""),
    sourceType: String(story.sourceType || "seed"),
    importedAt: String(story.importedAt || "")
  };
}

function applyFilters(reels, query) {
  const rangeDays = clamp(Number(query.range || 365), 7, 365);
  const from = query.from ? startOfDay(new Date(query.from)) : daysAgo(rangeDays - 1);
  const to = query.to ? new Date(query.to) : now();
  const pillar = query.pillar && query.pillar !== "all" ? query.pillar : "";
  const hook = query.hook && query.hook !== "all" ? query.hook : "";
  const platform = query.platform && query.platform !== "all" ? query.platform : "";

  return reels.filter((reel) => {
    const postedAt = new Date(reel.postedAt);
    if (Number.isNaN(postedAt.getTime())) return false;
    if (postedAt < from || postedAt > to) return false;
    if (pillar && reel.pillar !== pillar) return false;
    if (hook && reel.hook !== hook) return false;
    if (platform && reel.platform !== platform) return false;
    return true;
  });
}

function dailySeries(reels) {
  const buckets = new Map();
  reels.forEach((reel) => {
    const key = dateKey(reel.postedAt);
    if (!buckets.has(key)) {
      buckets.set(key, { date: key, views: 0, saves: 0, followers: 0, retention: 0, posts: 0 });
    }
    const bucket = buckets.get(key);
    bucket.views += reel.views;
    bucket.saves += reel.saves;
    bucket.followers += reel.followersGained;
    bucket.retention += reel.retention;
    bucket.posts += 1;
  });
  return [...buckets.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((bucket) => ({
      ...bucket,
      retention: round(bucket.retention / bucket.posts, 1)
    }));
}

function groupedStats(reels, key) {
  const buckets = new Map();
  reels.forEach((reel) => {
    const label = reel[key];
    if (!buckets.has(label)) {
      buckets.set(label, {
        label,
        posts: 0,
        views: 0,
        saves: 0,
        retention: 0,
        followers: 0
      });
    }
    const bucket = buckets.get(label);
    bucket.posts += 1;
    bucket.views += reel.views;
    bucket.saves += reel.saves;
    bucket.retention += reel.retention;
    bucket.followers += reel.followersGained;
  });
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      avgViews: round(bucket.views / bucket.posts, 0),
      avgSaves: round(bucket.saves / bucket.posts, 0),
      avgRetention: round(bucket.retention / bucket.posts, 1),
      avgFollowers: round(bucket.followers / bucket.posts, 0)
    }))
    .sort((left, right) => right.avgViews - left.avgViews);
}

function postingHeatmap(reels) {
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const buckets = Array.from({ length: 7 }, (_, dayIndex) =>
    Array.from({ length: 4 }, (_, slotIndex) => ({
      dayIndex,
      slotIndex,
      dayLabel: dayLabels[dayIndex],
      slotLabel: ["6-11", "12-15", "16-19", "20-23"][slotIndex],
      score: 0,
      posts: 0
    }))
  );

  reels.forEach((reel) => {
    const date = new Date(reel.postedAt);
    const slotIndex = clamp(Math.floor((date.getHours() - 6) / 4), 0, 3);
    const bucket = buckets[date.getDay()][slotIndex];
    bucket.posts += 1;
    bucket.score += reel.views * 0.45 + reel.saves * 6 + reel.retention * 80;
  });

  return buckets.flat().map((bucket) => ({
    ...bucket,
    score: bucket.posts ? round(bucket.score / bucket.posts, 0) : 0
  }));
}

function topReels(reels) {
  return [...reels]
    .sort((left, right) => right.views - left.views)
    .slice(0, 5)
    .map((reel) => ({
      id: reel.id,
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      views: fmtCompact(reel.views),
      saves: fmtCompact(reel.saves),
      retention: fmtPercent(reel.retention),
      postedAt: reel.postedAt
    }));
}

function computeInsights(reels, hookStats, pillarStats) {
  if (!reels.length) return [];
  const bestHook = hookStats[0];
  const weakestHook = [...hookStats].sort((left, right) => left.avgRetention - right.avgRetention)[0];
  const bestPillar = pillarStats[0];
  const bestHour = postingHeatmap(reels).sort((left, right) => right.score - left.score)[0];

  return [
    {
      id: "hook-leader",
      tag: "Hook",
      title: `${bestHook.label} hooks are still leading`,
      body: `${bestHook.label} posts average ${fmtCompact(bestHook.avgViews)} views and ${fmtPercent(bestHook.avgRetention)} retention.`,
      citation: { view: "performance", section: "hookChart", label: "Hook comparison" }
    },
    {
      id: "hook-risk",
      tag: "Risk",
      title: `${weakestHook.label} is dragging watch depth`,
      body: `${weakestHook.label} has the weakest average retention at ${fmtPercent(weakestHook.avgRetention)}. Rework the opener or use it less.`,
      citation: { view: "performance", section: "hookChart", label: "Hook comparison" }
    },
    {
      id: "pillar-winner",
      tag: "Pillar",
      title: `${bestPillar.label} is your highest-output pillar`,
      body: `${bestPillar.label} is driving ${fmtCompact(bestPillar.views)} total views across ${bestPillar.posts} posts in the selected window.`,
      citation: { view: "performance", section: "pillarChart", label: "Pillar performance" }
    },
    {
      id: "time-window",
      tag: "Timing",
      title: `${bestHour.dayLabel} ${bestHour.slotLabel} is the cleanest slot`,
      body: "This slot currently has the best blended score from views, saves, and retention.",
      citation: { view: "performance", section: "heatmap", label: "Posting window heatmap" }
    }
  ];
}

function computeKpis(current, previous) {
  const currentViews = sum(current, "views");
  const previousViews = sum(previous, "views");
  const currentFollowers = sum(current, "followersGained");
  const previousFollowers = sum(previous, "followersGained");
  const currentSaves = sum(current, "saves");
  const previousSaves = sum(previous, "saves");
  const currentRetention = avg(current, "retention");
  const previousRetention = avg(previous, "retention");

  return [
    {
      id: "views",
      label: "Views",
      value: fmtCompact(currentViews),
      raw: currentViews,
      delta: fmtSignedPercent(previousViews ? ((currentViews / previousViews) - 1) * 100 : 0),
      icon: "📈"
    },
    {
      id: "followers",
      label: "Followers gained",
      value: `+${fmtCompact(currentFollowers)}`,
      raw: currentFollowers,
      delta: fmtSignedPercent(previousFollowers ? ((currentFollowers / previousFollowers) - 1) * 100 : 0),
      icon: "👥"
    },
    {
      id: "saves",
      label: "Saves",
      value: fmtCompact(currentSaves),
      raw: currentSaves,
      delta: fmtSignedPercent(previousSaves ? ((currentSaves / previousSaves) - 1) * 100 : 0),
      icon: "🔖"
    },
    {
      id: "retention",
      label: "Avg retention",
      value: fmtPercent(currentRetention),
      raw: currentRetention,
      delta: fmtSignedPercent(previousRetention ? currentRetention - previousRetention : 0),
      icon: "⏱"
    }
  ];
}

function relativeTime(dateString) {
  const target = new Date(dateString);
  const minutes = Math.max(0, Math.round((now() - target) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function tokenizeInterestText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s&/+.-]/g, " ")
    .split(/[\s,/+&.-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function creatorInterestSignals(store) {
  const nicheTokens = tokenizeInterestText(store.creator?.niche);
  const pillarTokens = store.reels.flatMap((reel) => tokenizeInterestText(reel?.pillar));
  const competitorTokens = store.competitors.flatMap((competitor) => tokenizeInterestText(`${competitor?.angle || ""} ${competitor?.bestFormat || ""}`));
  const manualSynonyms = {
    d2c: ["brand", "brands", "consumer", "commerce", "retail", "ecommerce", "startup", "founder"],
    creator: ["creators", "influencer", "influencers", "audience", "instagram", "youtube", "monetisation", "monetization"],
    economy: ["business", "market", "markets", "funding", "startup", "growth"],
    business: ["startup", "founder", "brand", "brands", "growth", "market", "monetisation", "monetization"],
    finance: ["funding", "ipo", "capital", "valuation", "investing", "markets"],
    market: ["markets", "ipo", "capital", "valuation", "funding"],
    content: ["reel", "reels", "instagram", "video", "audience", "storytelling"],
    strategy: ["growth", "distribution", "positioning", "retention", "conversion"]
  };

  const expanded = new Set([...nicheTokens, ...pillarTokens, ...competitorTokens]);
  [...expanded].forEach((token) => {
    (manualSynonyms[token] || []).forEach((related) => expanded.add(related));
  });

  return [...expanded];
}

function inferCreatorIdentity(store) {
  const reels = (store.reels || []).map(normalizeReel);
  const topHandle = inferPrimaryCreatorHandle(store);
  const dominantPillars = groupedStats(reels, "pillar")
    .slice(0, 2)
    .map((item) => item.label)
    .filter(Boolean);
  const topTopics = (store.news || [])
    .map(normalizeNews)
    .slice(0, 3)
    .map((story) => story.topic)
    .filter(Boolean);
  const manualName = String(store.creator?.name || "").trim();
  const manualNiche = String(store.creator?.niche || "").trim();
  const manualFollowers = Number(store.creator?.followers || 0);
  const inferredFollowers = reels
    .filter((reel) => String(reel.sourceHandle || "").trim().toLowerCase() === topHandle)
    .reduce((max, reel) => Math.max(max, Number(reel.sourceFollowers || 0)), 0);
  const followers = manualFollowers || inferredFollowers || 0;
  const derivedName = manualName || titleCase(topHandle || "Creator OS");
  const derivedNiche = manualNiche || [...new Set([...dominantPillars, ...topTopics])].slice(0, 3).join(", ") || "Creator analytics";
  return {
    name: derivedName,
    niche: derivedNiche,
    handle: String(store.creator?.handle || topHandle || "").trim().toLowerCase(),
    followers,
    followersLabel: followers ? fmtCompact(followers) : "0"
  };
}

function inferPrimaryCreatorHandle(store) {
  const manualHandle = String(store.creator?.handle || "").replace(/^@/, "").trim().toLowerCase();
  if (manualHandle) return manualHandle;

  const reels = (store.reels || [])
    .map(normalizeReel)
    .filter((reel) => String(reel.sourceHandle || "").trim());
  if (!reels.length) return "";

  const counts = new Map();
  reels.forEach((reel) => {
    const handle = String(reel.sourceHandle || "").trim().toLowerCase();
    const previous = counts.get(handle) || { count: 0, views: 0 };
    counts.set(handle, {
      count: previous.count + 1,
      views: previous.views + Number(reel.views || 0)
    });
  });

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1].count !== left[1].count) return right[1].count - left[1].count;
      return right[1].views - left[1].views;
    })[0]?.[0] || "";
}

function scoreNewsForCreator(story, store) {
  const publishedAt = new Date(story.publishedAt);
  const ageHours = Math.max(0, (now() - publishedAt) / 36e5);
  const recencyBoost = Math.max(0, 24 - ageHours) * 0.8;
  const storyText = [
    story.topic,
    story.headline,
    story.summary,
    story.source
  ].join(" ").toLowerCase();
  const interestSignals = creatorInterestSignals(store);
  const matchedSignals = interestSignals.filter((token) => storyText.includes(token));
  const nicheBoost = Math.min(28, matchedSignals.length * 4);
  const positiveSignals = (storyText.match(/\b(d2c|creator|startup|founder|brand|consumer|retention|monetisation|monetization|instagram|youtube|influencer|marketing|economy|funding|venture|business|finance)\b/g) || []).length;
  const offNicheSignals = (storyText.match(/\b(beauty|skincare|makeup|fashion|luxury|celebrity gossip|movie|bollywood|tv serial|cricket)\b/g) || []).length;
  const qualityAdjust = Math.min(16, positiveSignals * 2) - Math.min(18, offNicheSignals * 6);

  return {
    nicheScore: Math.max(0, Math.round(nicheBoost + qualityAdjust)),
    matchedSignals: [...new Set(matchedSignals)].slice(0, 8),
    rankingScore: Number(story.relevance || 0) + nicheBoost + qualityAdjust + recencyBoost
  };
}

function newsRecommendationType(story) {
  const text = `${story.topic} ${story.headline} ${story.summary}`.toLowerCase();
  if (/(instagram|youtube|creator|creators|monetisation|monetization|platform)/.test(text)) {
    return { id: "reel", label: "Best for reel" };
  }
  if (/(brand|funding|valuation|ipo|capital|market|markets|consumer|growth)/.test(text)) {
    return { id: "market", label: "Market update" };
  }
  return { id: "response", label: "Competitor response" };
}

function newsNicheFitLabel(nicheScore) {
  if (nicheScore >= 24) return "High niche fit";
  if (nicheScore >= 14) return "Good niche fit";
  return "Watchlist fit";
}

function storyLeadAngle(story, store) {
  const niche = String(store.creator?.niche || "your niche").toLowerCase();
  const type = newsRecommendationType(story);
  if (type.id === "reel") {
    return `Why this ${story.topic.toLowerCase()} shift matters for ${niche} creators right now.`;
  }
  if (type.id === "market") {
    return `What this ${story.topic.toLowerCase()} signal says about where ${niche} opportunities are moving next.`;
  }
  return `How creators in ${niche} should respond before this angle gets crowded.`;
}

function storyHookOptions(story, store) {
  const niche = String(store.creator?.niche || "this niche");
  const topic = String(story.topic || "story").toLowerCase();
  return [
    `Everyone in ${niche} is missing what this ${topic} headline really means.`,
    `If you create around ${niche}, this ${topic} update should change your next reel.`,
    `This ${topic} story looks small, but it could reshape how creators grow next.`
  ];
}

function buildReelBlueprint(story, store) {
  const hooks = storyHookOptions(story, store);
  return {
    angle: storyLeadAngle(story, store),
    hooks,
    structure: [
      `Hook: ${hooks[0]}`,
      `Context: explain "${story.headline}" in one sharp sentence.`,
      `Why it matters: connect it to ${String(store.creator?.niche || "the creator niche").toLowerCase()}.`,
      "Takeaway: give one opinionated implication or move to watch next.",
      "CTA: ask viewers to follow for the next high-signal niche breakdown."
    ],
    cta: "Follow for more niche-specific business and creator signals."
  };
}

function fallbackHeroCopy(dashboard) {
  const topPost = dashboard.topReels[0];
  const topCompetitor = dashboard.competitors[0];
  const leadHook = dashboard.charts.hooks[0]?.label || "High-signal hooks";
  return {
    title: topPost ? `${leadHook}, decoded.` : "Signal over vanity metrics.",
    subtitle: topCompetitor
      ? `Track what is working, where ${topCompetitor.name} is moving, and what your next reel should be.`
      : "One place to track what is working, who is moving, and what your next reel should be."
  };
}

function usesLegacyBranding(store) {
  const title = String(store.branding?.title || "").trim().toLowerCase();
  const subtitle = String(store.branding?.subtitle || "").trim().toLowerCase();
  return !title
    || title === "signal over vanity metrics."
    || subtitle === "one place to track what is working, who is moving, and what your next reel should be.";
}

function fallbackSuggestions(dashboard) {
  const topCompetitor = dashboard.competitors[0]?.name || "top competitor";
  const topPillar = dashboard.charts.pillars[0]?.label || "best-performing pillar";
  const topNews = dashboard.news[0]?.headline || "top story";
  return [
    `Why is my ${topPillar} content working right now?`,
    `What should I post next based on my current hooks?`,
    `Break down ${topCompetitor}'s recent content momentum.`,
    `Turn "${topNews}" into a reel angle.`,
    "Which post should I re-cut for better watch depth?"
  ];
}

function dashboardDecorCacheKey(store, dashboard) {
  return JSON.stringify({
    creator: inferCreatorIdentity(store),
    posts: dashboard.posts.slice(0, 8).map((post) => ({
      id: post.id,
      title: post.title,
      hook: post.hook,
      pillar: post.pillar,
      views: post.views,
      engagementRate: post.engagementRate,
      retention: post.retention
    })),
    competitors: dashboard.competitors.slice(0, 5).map((competitor) => ({
      name: competitor.name,
      monthlyGrowth: competitor.monthlyGrowth,
      engagementRate: competitor.engagementRate,
      bestFormat: competitor.bestFormat
    })),
    news: dashboard.news.slice(0, 6).map((story) => ({
      id: story.id,
      headline: story.headline,
      topic: story.topic,
      summary: story.summary,
      relevance: story.relevance
    }))
  });
}

async function openAiStructuredJson(prompt) {
  if (!process.env.OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: openAiModel,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      ]
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI structured request failed with ${response.status}${details ? `: ${details}` : ""}`);
  }
  const result = await response.json();
  return safeJsonObject(result.output_text, null);
}

async function structuredDashboardAi(prompt, responseFormat) {
  if (geminiApiKey) {
    const result = await geminiTextInteraction({ prompt, responseFormat });
    return safeJsonObject(interactionOutputText(result), null);
  }
  if (process.env.OPENAI_API_KEY) {
    return openAiStructuredJson(prompt);
  }
  return null;
}

async function generateDashboardDecorations(store, dashboard) {
  const cacheKey = dashboardDecorCacheKey(store, dashboard);
  const cached = dashboardDecorCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < 10 * 60_000) {
    return cached.payload;
  }

  const creator = inferCreatorIdentity(store);
  const prompt = [
    "You are generating copy for a creator analytics dashboard.",
    "Use only the provided data.",
    "Do not invent numbers, names, or claims.",
    "Return JSON only with keys: header, suggestions, insights, blueprints.",
    "header: object with title and subtitle.",
    "suggestions: array of 5 short assistant prompts.",
    "insights: array of 4 objects with id, tag, title, body.",
    "blueprints: array of objects with id, angle, hooks, structure, cta for each story id.",
    "Make copy premium, concise, and specific to the dashboard.",
    "",
    JSON.stringify({
      creator,
      summary: dashboard.summary,
      topPosts: dashboard.posts.slice(0, 5).map((post) => ({
        id: post.id,
        title: post.title,
        pillar: post.pillar,
        hook: post.hook,
        views: post.viewsLabel,
        engagementRate: post.engagementRateLabel,
        retention: post.retentionLabel
      })),
      competitors: dashboard.competitors.slice(0, 3).map((competitor) => ({
        name: competitor.name,
        angle: competitor.angle,
        monthlyGrowth: competitor.monthlyGrowthLabel,
        bestFormat: competitor.bestFormat,
        warning: competitor.warning
      })),
      news: dashboard.news.slice(0, 5).map((story) => ({
        id: story.id,
        topic: story.topic,
        headline: story.headline,
        summary: story.summary,
        nicheFit: story.nicheFitLabel,
        matchedSignals: story.matchedSignals
      })),
      hookStats: dashboard.charts.hooks.slice(0, 3),
      pillarStats: dashboard.charts.pillars.slice(0, 3)
    })
  ].join("\n");

  const payload = await structuredDashboardAi(prompt, {
    type: "object",
    properties: {
      header: {
        type: "object",
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" }
        }
      },
      suggestions: {
        type: "array",
        items: { type: "string" }
      },
      insights: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            tag: { type: "string" },
            title: { type: "string" },
            body: { type: "string" }
          }
        }
      },
      blueprints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            angle: { type: "string" },
            hooks: {
              type: "array",
              items: { type: "string" }
            },
            structure: {
              type: "array",
              items: { type: "string" }
            },
            cta: { type: "string" }
          }
        }
      }
    }
  }).catch(() => null);

  const normalized = {
    header: {
      title: sanitizeShortLabel(payload?.header?.title, fallbackHeroCopy(dashboard).title, 56),
      subtitle: String(payload?.header?.subtitle || fallbackHeroCopy(dashboard).subtitle).trim()
    },
    suggestions: Array.isArray(payload?.suggestions) && payload.suggestions.length
      ? payload.suggestions.map((item) => sanitizeShortLabel(item, "", 90)).filter(Boolean).slice(0, 5)
      : fallbackSuggestions(dashboard),
    insights: Array.isArray(payload?.insights) && payload.insights.length
      ? payload.insights.slice(0, 4).map((item, index) => ({
          id: sanitizeShortLabel(item?.id, `ai-insight-${index + 1}`, 24).toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
          tag: sanitizeShortLabel(item?.tag, "Signal", 18),
          title: sanitizeShortLabel(item?.title, dashboard.insights[index]?.title || "High-signal insight", 96),
          body: String(item?.body || dashboard.insights[index]?.body || "").trim()
        }))
      : dashboard.insights,
    blueprints: new Map(
      (Array.isArray(payload?.blueprints) ? payload.blueprints : []).map((item) => [
        String(item?.id || ""),
        {
          angle: String(item?.angle || "").trim(),
          hooks: Array.isArray(item?.hooks) ? item.hooks.map((hook) => String(hook || "").trim()).filter(Boolean).slice(0, 3) : [],
          structure: Array.isArray(item?.structure) ? item.structure.map((step) => String(step || "").trim()).filter(Boolean).slice(0, 5) : [],
          cta: String(item?.cta || "").trim()
        }
      ])
    )
  };
  dashboardDecorCache.set(cacheKey, { updatedAt: Date.now(), payload: normalized });
  return normalized;
}

function competitorMatchKeys(profile) {
  return new Set(
    [
      profile.handle,
      ...(profile.aliases || []),
      slugify(profile.name),
      ...String(profile.name || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4)
    ].filter(Boolean)
  );
}

function reelMatchesCompetitorProfile(reel, profile) {
  const keys = competitorMatchKeys(profile);
  const sourceHandle = String(reel.sourceHandle || "").toLowerCase();
  const sourceName = slugify(reel.sourceName || "");
  const title = String(reel.title || "").toLowerCase();
  const caption = String(reel.caption || "").toLowerCase();
  if (sourceHandle && keys.has(sourceHandle)) return true;
  if (sourceName && [...keys].some((key) => sourceName.includes(key) || key.includes(sourceName))) return true;
  return [...keys].some((key) => key && (title.includes(key) || caption.includes(key)));
}

function apifyConfig(store) {
  const config = store.integrations?.apify || {};
  return {
    token: process.env.APIFY_TOKEN || config.token || "",
    mode: config.mode || "actor",
    actorId: process.env.APIFY_ACTOR_ID || config.actorId || "",
    profileActorId: process.env.APIFY_PROFILE_ACTOR_ID || config.profileActorId || "apify~instagram-profile-scraper",
    taskId: config.taskId || "",
    datasetId: config.datasetId || "",
    input: config.input || {},
    autoImportEnabled: apifyAutoImportEnabledEnv || config.autoImportEnabled === true,
    autoImportIntervalMinutes: Math.max(15, Number(config.autoImportIntervalMinutes || apifyAutoImportIntervalMinutesEnv || 60)),
    autoImportUsername: apifyAutoImportUsernameEnv || String(config.autoImportUsername || "").replace(/^@/, "").trim().toLowerCase(),
    autoImportResultsLimit: Math.max(1, Math.min(10, Number(config.autoImportResultsLimit || apifyAutoImportResultsLimitEnv || 3))),
    lastAutoImportAt: String(config.lastAutoImportAt || ""),
    lastAutoImportStatus: String(config.lastAutoImportStatus || "")
  };
}

function brightDataConfig(store) {
  const config = store.integrations?.brightData || {};
  return {
    apiKey: process.env.BRIGHT_DATA_API_KEY || config.apiKey || "",
    datasetId: process.env.BRIGHT_DATA_DATASET_ID || config.datasetId || "",
    input: Array.isArray(config.input) ? config.input : []
  };
}

function winsterConfig(store) {
  const config = store.integrations?.winster || {};
  return {
    enabled:
      String(process.env.WINSTER_ENABLED || config.enabled || "").toLowerCase() === "true" ||
      config.enabled === true,
    baseUrl: process.env.WINSTER_BASE_URL || config.baseUrl || "",
    apiKey: process.env.WINSTER_API_KEY || config.apiKey || "",
    model: process.env.WINSTER_MODEL || config.model || "",
    path: process.env.WINSTER_PATH || config.path || "/chat"
  };
}

function newsConfig(store) {
  const config = store.integrations?.news || {};
  return {
    lastLiveRunAt: String(config.lastLiveRunAt || ""),
    lastSource: String(config.lastSource || ""),
    queries: Array.isArray(config.queries) ? config.queries.map((query) => String(query || "")) : [],
    lookbackDays: Number(config.lookbackDays || newsLookbackDays)
  };
}

function isRecentNewsStory(story, lookbackDays = newsLookbackDays) {
  const publishedAt = new Date(story.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) return false;
  return publishedAt >= daysAgo(Math.max(1, Number(lookbackDays || newsLookbackDays)) - 1);
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#8217;", "'")
    .replaceAll("&#8211;", "-");
}

function stripHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenizeNiche(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function buildLiveNewsQueries(store) {
  const niche = String(store.creator?.niche || "").trim();
  const nicheParts = niche.split(",").map((part) => part.trim()).filter(Boolean);
  const creatorName = String(store.creator?.name || "").trim();
  const competitorAngles = (store.competitorProfiles || [])
    .map((profile) => {
      const angle = String(profile?.angle || "").trim();
      if (!angle) return "";
      if (/finance/i.test(angle)) return "personal finance India creators";
      if (/founder|interview/i.test(angle)) return "Indian founders creator economy";
      if (/growth/i.test(angle)) return "career growth India creators";
      return `${angle} India creators`;
    })
    .filter(Boolean)
    .slice(0, 3);
  const candidates = [
    niche,
    creatorName ? `${creatorName} industry trends India` : "",
    ...nicheParts.filter((part) => !/^business$/i.test(part)),
    ...competitorAngles,
    "creator economy India",
    "D2C India",
    "Indian startups creator economy",
    "creator monetisation India",
    "creator monetization India",
    "influencer marketing India",
    "content creators India",
    "founder led brands India",
    "startup marketing India",
    "personal brand founders India",
    "Instagram creators India",
    "YouTube creators India",
    "D2C brands India",
    "consumer brands India startups",
    "consumer internet India founders",
    "brand marketing India creators",
    "social commerce India",
    "direct to consumer India funding",
    "founder branding India",
    "Indian creator startups",
    "business creators India"
  ];
  const unique = [];
  const seen = new Set();
  candidates.forEach((value) => {
    const normalized = value.toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    unique.push(value);
  });
  return unique.slice(0, newsQueryLimit);
}

function topicFromQuery(query) {
  const normalized = String(query || "").toLowerCase();
  if (normalized.includes("d2c")) return "D2C";
  if (normalized.includes("brand")) return "Brands";
  if (normalized.includes("marketing")) return "Marketing";
  if (normalized.includes("market")) return "Markets";
  if (normalized.includes("finance")) return "Finance";
  if (normalized.includes("creator")) return "Creator economy";
  if (normalized.includes("startup")) return "Startups";
  return "Niche signals";
}

function sourceFromLink(link) {
  try {
    const host = new URL(link).hostname.replace(/^www\./, "");
    return host.split(".").slice(0, -1).join(".") || host;
  } catch {
    return "Live feed";
  }
}

function parseRssItems(xml, topic, query) {
  const items = [...String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  return items.map((match, index) => {
    const block = match[0];
    const readTag = (tag) => {
      const result = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return result ? stripHtml(result[1]) : "";
    };
    const readCdataTag = (tag) => {
      const result = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
      return result ? stripHtml(result[1]) : "";
    };
    const link = readTag("link");
    const rawTitle = readCdataTag("title");
    const titleParts = rawTitle.split(" - ");
    const headline = titleParts.length > 1 ? titleParts.slice(0, -1).join(" - ").trim() : rawTitle;
    const googleSource = titleParts.length > 1 ? titleParts.at(-1).trim() : "";
    const summary = stripHtml(readCdataTag("description"))
      .replace(/\s+/g, " ")
      .trim();
    const publishedAt = readTag("pubDate");
    return normalizeNews({
      id: link || `rss-${slugify(headline)}-${index}`,
      source: googleSource || sourceFromLink(link),
      headline,
      summary: summary && summary !== headline ? summary : `Live story matching ${query}.`,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : new Date().toISOString(),
      relevance: 72 + Math.max(0, 18 - index * 2),
      topic,
      url: link,
      sourceType: "live-rss",
      importedAt: new Date().toISOString(),
      query
    });
  }).filter((item) => item.headline);
}

function mergeNewsById(existing, incoming) {
  const byId = new Map();
  [...existing, ...incoming].forEach((story) => {
    const normalized = normalizeNews(story);
    const key = normalized.url || normalized.id || normalized.headline.toLowerCase();
    byId.set(String(key), normalized);
  });
  return [...byId.values()]
    .sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt))
    .slice(0, 80);
}

async function fetchGoogleNewsRss(query, lookbackDays = newsLookbackDays) {
  const candidates = [
    `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${lookbackDays}d`)}&hl=en-IN&gl=IN&ceid=IN:en`,
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`
  ];

  let lastStatus = 0;
  for (const endpoint of candidates) {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Creator-OS/1.0"
      }
    });
    lastStatus = response.status;
    if (!response.ok) continue;
    const text = await response.text();
    if (/<item\b/i.test(text)) return text;
  }
  throw new Error(`Live news fetch failed with ${lastStatus || 500}`);
}

async function runLiveNewsImport(store, options = {}) {
  const config = newsConfig(store);
  const lookbackDays = Math.min(30, Math.max(1, Number(options.lookbackDays || config.lookbackDays || newsLookbackDays)));
  const queries = Array.isArray(options.queries) && options.queries.length
    ? options.queries.map((query) => String(query || "").trim()).filter(Boolean)
    : buildLiveNewsQueries(store);
  if (!queries.length) throw new Error("No live news queries available.");

  const perQuery = clamp(Number(options.perQuery || 10), 1, 20);
  const collected = [];
  for (const query of queries) {
    const xml = await fetchGoogleNewsRss(query, lookbackDays);
    const parsed = parseRssItems(xml, topicFromQuery(query), query)
      .filter((story) => isRecentNewsStory(story, lookbackDays))
      .slice(0, perQuery);
    collected.push(...parsed);
  }

  const scored = collected
    .map((story) => ({
      story,
      score: scoreNewsForCreator(story, store)
    }))
    .sort((left, right) => {
      if (right.score.nicheScore !== left.score.nicheScore) return right.score.nicheScore - left.score.nicheScore;
      if (right.story.relevance !== left.story.relevance) return right.story.relevance - left.story.relevance;
      return new Date(right.story.publishedAt) - new Date(left.story.publishedAt);
    })
    .map(({ story }) => story)
    .slice(0, 80);

  if (!scored.length) throw new Error("No niche-relevant live news stories were returned.");

  const next = sanitizeStorePatch({
    news: mergeNewsById(store.news || [], scored),
    integrations: {
      news: {
        lastLiveRunAt: new Date().toISOString(),
        lastSource: "google-news-rss",
        queries,
        lookbackDays
      }
    }
  }, store);
  await writeStore(next);
  return {
    store: next,
    importedCounts: {
      news: scored.length
    },
    queries
  };
}

function groupByHandle(reels) {
  const buckets = new Map();
  reels.forEach((reel) => {
    const handle = String(reel.sourceHandle || "").trim().toLowerCase();
    if (!handle) return;
    if (!buckets.has(handle)) buckets.set(handle, []);
    buckets.get(handle).push(reel);
  });
  return buckets;
}

function computeMomentumPercent(reels) {
  const ordered = [...reels].sort((left, right) => new Date(left.postedAt) - new Date(right.postedAt));
  if (ordered.length < 2) return 0;
  const split = Math.max(1, Math.floor(ordered.length / 2));
  const older = ordered.slice(0, split);
  const newer = ordered.slice(split);
  const olderAvg = avg(older, "views");
  const newerAvg = avg(newer.length ? newer : older, "views");
  if (!olderAvg) return 0;
  return ((newerAvg / olderAvg) - 1) * 100;
}

function bestLabelByViews(reels, key, fallback) {
  const ranked = groupedStats(reels, key);
  return ranked[0]?.label || fallback;
}

function computeCompetitorRows(store) {
  const competitorReels = (store.competitorReels || []).map(normalizeReel);
  const explicitProfiles = (store.competitorProfiles || []).map(normalizeCompetitorProfile).filter((profile) => profile.handle);
  const profileByHandle = new Map(
    explicitProfiles.map((profile) => [String(profile.handle || "").trim().toLowerCase(), profile]),
  );
  const inferredProfiles = [...new Set(
    competitorReels
      .map((reel) => String(reel.sourceHandle || "").trim().toLowerCase())
      .filter(Boolean),
  )]
    .filter((handle) => !profileByHandle.has(handle))
    .map((handle) => {
      const related = competitorReels.filter((reel) => String(reel.sourceHandle || "").trim().toLowerCase() === handle);
      const latest = [...related].sort((left, right) => new Date(right.postedAt) - new Date(left.postedAt))[0];
      return normalizeCompetitorProfile({
        handle,
        name: latest?.sourceName || latest?.ownerFullName || handle,
        followers: Number(latest?.sourceFollowers || 0),
        profileUrl: `https://www.instagram.com/${handle}/`,
        angle: "Imported competitor"
      });
    });
  const profiles = [...explicitProfiles, ...inferredProfiles];
  const legacyByName = new Map(
    (store.competitors || [])
      .map(normalizeCompetitor)
      .map((competitor) => [competitor.name.toLowerCase(), competitor]),
  );
  const legacyByHandle = new Map(
    (store.competitors || [])
      .map(normalizeCompetitor)
      .map((competitor) => [String(competitor.canonicalHandle || "").trim().toLowerCase(), competitor]),
  );
  if (!profiles.length || !competitorReels.length) {
    const mergedRows = profiles.length
      ? profiles.map((profile) => {
          const handle = String(profile.handle || "").trim().toLowerCase();
          const legacy =
            legacyByHandle.get(handle) ||
            legacyByName.get(String(profile.name || "").toLowerCase());
          const followers = Number(profile.followers || legacy?.followers || 0);
          const postsPerWeek = Number(legacy?.postsPerWeekSeed || 0);
          const avgViews = Number(legacy?.avgViewsSeed || 0);
          const topHook = String(legacy?.topHookSeed || legacy?.warning || "Story hook");
          return {
            name: profile.name || legacy?.name || profile.handle,
            angle: profile.angle || legacy?.angle || "",
            canonicalHandle: handle,
            aliases: [...competitorMatchKeys(profile)],
            importedPosts: Number(legacy?.importedPosts || 0),
            postsPerWeek,
            postsPerWeekLabel: postsPerWeek ? round(postsPerWeek, 1).toFixed(1) : "0.0",
            avgViews,
            avgViewsLabel: fmtCompact(avgViews),
            monthlyGrowth: Number(legacy?.monthlyGrowth || 0),
            followers,
            engagementRate: Number(legacy?.engagementRate || 0),
            bestFormat: legacy?.bestFormat || "Unknown",
            topHook,
            warning: legacy?.warning || "No content imported yet",
            topPostTitle: legacy?.topPostTitle || "",
            topPostUrl: legacy?.topPostUrl || "",
            topPostViews: Number(legacy?.topPostViews || 0),
            topPostViewsLabel: fmtCompact(Number(legacy?.topPostViews || 0)),
            reels: Array.isArray(legacy?.reels) ? legacy.reels : [],
            monthlyGrowthLabel: fmtSignedPercent(Number(legacy?.monthlyGrowth || 0), 1),
            followersLabel: fmtCompact(followers),
            engagementRateLabel: fmtPercent(Number(legacy?.engagementRate || 0), 1)
          };
        })
      : (store.competitors || []).map(normalizeCompetitor).map((competitor) => ({
          ...competitor,
          postsPerWeek: Number(competitor.postsPerWeekSeed || 0),
          postsPerWeekLabel: Number(competitor.postsPerWeekSeed || 0) ? round(Number(competitor.postsPerWeekSeed || 0), 1).toFixed(1) : "0.0",
          avgViews: Number(competitor.avgViewsSeed || 0),
          avgViewsLabel: fmtCompact(Number(competitor.avgViewsSeed || 0)),
          topHook: String(competitor.topHookSeed || competitor.warning || "Story hook"),
          monthlyGrowthLabel: fmtSignedPercent(competitor.monthlyGrowth, 1),
          followersLabel: fmtCompact(competitor.followers),
          engagementRateLabel: fmtPercent(competitor.engagementRate, 1)
        }));

    return mergedRows.sort((left, right) => right.monthlyGrowth - left.monthlyGrowth);
  }

  return profiles
    .map((profile) => {
      const aliases = [...competitorMatchKeys(profile)];
      const reels = competitorReels.filter((reel) => reelMatchesCompetitorProfile(reel, profile));
      const latest = [...reels].sort((left, right) => new Date(right.postedAt) - new Date(left.postedAt))[0];
      const handle = String(profile.handle || "").trim().toLowerCase();
      const legacy =
        legacyByHandle.get(handle) ||
        legacyByName.get(String(profile.name || "").toLowerCase());
      const followers = profile.followers || latest?.sourceFollowers || legacy?.followers || 0;
      const totalViews = sum(reels, "views");
      const engagementRate = reels.length && totalViews > 0
        ? ((sum(reels, "likes") + sum(reels, "comments") + sum(reels, "shares") + sum(reels, "saves")) / totalViews) * 100
        : legacy?.engagementRate || 0;
      const monthlyGrowth = reels.length ? computeMomentumPercent(reels) : Number(legacy?.monthlyGrowth || 0);
      const postsPerWeek = reels.length ? reels.length / 4 : Number(legacy?.postsPerWeekSeed || 0);
      const avgViews = reels.length ? totalViews / reels.length : Number(legacy?.avgViewsSeed || 0);
      const topPost = [...reels].sort((left, right) => right.views - left.views)[0];
      const importedPosts = reels.length || Number(legacy?.importedPosts || 0);
      const bestFormat = reels.length ? bestLabelByViews(reels, "format", legacy?.bestFormat || "Unknown") : (legacy?.bestFormat || "Unknown");
      const topHook = String(legacy?.topHookSeed || legacy?.warning || "Story hook");
      const warning = topPost?.title || legacy?.warning || "No content imported yet";
      const topPostTitle = topPost?.title || legacy?.topPostTitle || "";
      const topPostUrl = topPost?.url || legacy?.topPostUrl || "";
      const topPostViews = topPost?.views || legacy?.topPostViews || 0;
      const rankedReels = reels.length
        ? [...reels]
            // Keep the modal usable, but show a real recent history instead of only the top 5 by views.
            .sort((left, right) => new Date(right.postedAt) - new Date(left.postedAt))
            .slice(0, 100)
            .map((reel) => ({
              id: reel.id,
              title: reel.title,
              url: reel.url,
              mediaUrl: reel.mediaUrl,
              thumbnailUrl: reel.thumbnailUrl,
              caption: reel.caption,
              transcript: reel.transcript,
              timestampedTranscript: reel.timestampedTranscript,
              transcriptSource: reel.transcriptSource,
              scriptSummary: reel.scriptSummary,
              sceneBreakdown: reel.sceneBreakdown,
              analysisStatus: reel.analysisStatus,
              analysisError: reel.analysisError,
              analysisProvider: reel.analysisProvider,
              analysisUpdatedAt: reel.analysisUpdatedAt,
              hook: reel.hook,
              pillar: reel.pillar,
              format: reel.format,
              platform: reel.platform,
              postedAt: reel.postedAt,
              sourceHandle: reel.sourceHandle,
              sourceName: reel.sourceName,
              audioType: reel.audioType,
              tone: reel.tone,
              productionType: reel.productionType,
              language: reel.language,
              views: reel.views,
              likes: reel.likes,
              comments: reel.comments,
              shares: reel.shares,
              saves: reel.saves,
              retention: reel.retention,
              watchTime: reel.watchTime,
              viewsLabel: fmtCompact(reel.views),
              likesLabel: fmtCompact(reel.likes),
              postedAtLabel: new Date(reel.postedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
            }))
        : (Array.isArray(legacy?.reels) ? legacy.reels : []);
      return {
        name: profile.name || latest?.sourceName || profile.handle,
        angle: profile.angle,
        canonicalHandle: handle,
        aliases,
        importedPosts,
        postsPerWeek,
        postsPerWeekLabel: postsPerWeek ? round(postsPerWeek, 1).toFixed(1) : "0.0",
        avgViews,
        avgViewsLabel: fmtCompact(avgViews),
        monthlyGrowth,
        followers,
        engagementRate,
        bestFormat,
        topHook,
        warning,
        topPostTitle,
        topPostUrl,
        topPostViews,
        topPostViewsLabel: fmtCompact(topPostViews),
        reels: rankedReels,
        monthlyGrowthLabel: fmtSignedPercent(monthlyGrowth, 1),
        followersLabel: fmtCompact(followers),
        engagementRateLabel: fmtPercent(engagementRate, 1)
      };
    })
    .sort((left, right) => right.monthlyGrowth - left.monthlyGrowth);
}

function computeDashboard(store, query) {
  const reels = store.reels.map(normalizeReel);
  const creatorHandle = inferPrimaryCreatorHandle(store);
  const creatorReels = creatorHandle
    ? reels.filter((reel) => String(reel.sourceHandle || "").trim().toLowerCase() === creatorHandle)
    : reels;
  const filtered = applyFilters(creatorReels, query);
  const range = clamp(Number(query.range || 365), 7, 365);
  const previousWindowStart = daysAgo(range * 2 - 1);
  const previousWindowEnd = daysAgo(range);
  const previous = creatorReels.filter((reel) => {
    const postedAt = new Date(reel.postedAt);
    return postedAt >= previousWindowStart && postedAt < previousWindowEnd;
  });

  const series = dailySeries(filtered);
  const hookStats = groupedStats(filtered, "hook");
  const pillarStats = groupedStats(filtered, "pillar");
  const heatmap = postingHeatmap(filtered);
  const competitorRows = computeCompetitorRows(store);

  const configuredLookbackDays = newsConfig(store).lookbackDays || newsLookbackDays;
  const recentNews = store.news
    .map(normalizeNews)
    .filter((story) => isRecentNewsStory(story, configuredLookbackDays));
  const fallbackNews = recentNews.length
    ? recentNews
    : store.news
        .map(normalizeNews)
        .sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt))
        .slice(0, 12);
  const news = fallbackNews
    .map((story) => {
      const score = scoreNewsForCreator(story, store);
      const recommendation = newsRecommendationType(story);
      const reelBlueprint = buildReelBlueprint(story, store);
      return {
        ...story,
        recommendationType: recommendation.id,
        recommendationLabel: recommendation.label,
        nicheFitLabel: newsNicheFitLabel(score.nicheScore),
        nicheScore: score.nicheScore,
        matchedSignals: score.matchedSignals,
        rankingScore: score.rankingScore,
        reelBlueprint
      };
    })
    .sort((left, right) => {
      const dateDiff = new Date(right.publishedAt) - new Date(left.publishedAt);
      if (dateDiff) return dateDiff;
      return right.rankingScore - left.rankingScore;
    })
    .map((story) => ({
      ...story,
      age: relativeTime(story.publishedAt)
    }));
  const posts = filtered
    .slice()
    .sort((left, right) => new Date(right.postedAt) - new Date(left.postedAt))
    .map((reel) => {
      const interactions = Number(reel.likes || 0) + Number(reel.comments || 0) + Number(reel.shares || 0) + Number(reel.saves || 0);
      const hasViews = Number(reel.views || 0) > 0;
      const engagementRate = hasViews ? (interactions / Number(reel.views)) * 100 : 0;
      return {
        ...reel,
        viewsLabel: hasViews ? fmtCompact(reel.views) : interactions ? "Missing" : "0",
        likesLabel: fmtCompact(reel.likes),
        commentsLabel: fmtCompact(reel.comments),
        sharesLabel: fmtCompact(reel.shares),
        savesLabel: fmtCompact(reel.saves),
        followersLabel: fmtCompact(reel.followersGained),
        retentionLabel: fmtPercent(reel.retention, 1),
        watchTimeLabel: `${Number(reel.watchTime || 0).toFixed(1)}s`,
        engagementRate: Number(engagementRate.toFixed(2)),
        engagementRateLabel: hasViews ? fmtPercent(engagementRate, 2) : "N/A",
        postedAtLabel: new Date(reel.postedAt).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric"
        })
      };
    });
  const creator = inferCreatorIdentity(store);
  const heroCopy = fallbackHeroCopy({ topReels: topReels(filtered), competitors: competitorRows, charts: { hooks: hookStats, pillars: pillarStats }, summary: { posts: filtered.length } });
  const useDynamicHero = usesLegacyBranding(store);

  return {
    creator,
    filters: {
      range,
      pillar: query.pillar || "all",
      hook: query.hook || "all",
      platform: query.platform || "all"
    },
    filterOptions: {
      pillars: ["all", ...new Set(creatorReels.map((reel) => reel.pillar))],
      hooks: ["all", ...new Set(creatorReels.map((reel) => reel.hook))],
      platforms: ["all", ...new Set(creatorReels.map((reel) => reel.platform))]
    },
    header: {
      title: useDynamicHero ? heroCopy.title : String(store.branding.title || "").trim(),
      subtitle: useDynamicHero ? heroCopy.subtitle : String(store.branding.subtitle || "").trim(),
      rangeLabel: `Last ${range} days`,
      syncLabel: `Store updated ${relativeTime(store.meta.updatedAt)}`
    },
    ai: {
      mode: liveAiProviderLabel(store),
      apifyConfigured: Boolean(apifyConfig(store).token && (apifyConfig(store).actorId || apifyConfig(store).taskId))
    },
    dataSources: {
      reels: {
        status: posts.length ? "live-imported" : "empty",
        label: posts.length ? "Reels imported" : "No reels imported"
      },
      competitors: {
        status: (store.competitorReels || []).length ? "live-imported" : "seeded",
        label: (store.competitorReels || []).length ? "Competitors imported" : "Competitors seeded"
      },
      news: {
        status: news.some((story) => story.sourceType === "live-rss" || story.sourceType === "apify") ? "live-imported" : "seeded",
        label: recentNews.length
          ? `News imported live (${configuredLookbackDays}d)`
          : (news.length ? `Showing latest stored news` : `No recent news (${configuredLookbackDays}d)`),
        lastLiveRunAt: newsConfig(store).lastLiveRunAt,
        lastSource: newsConfig(store).lastSource,
        lookbackDays: newsConfig(store).lookbackDays
      },
      transcription: {
        status: transcriptionProvider === "local" ? "self-hosted" : "api",
        label: transcriptionModeLabel()
      }
    },
    kpis: computeKpis(filtered, previous),
    posts,
    topReels: topReels(filtered),
    insights: computeInsights(filtered, hookStats, pillarStats),
    competitors: competitorRows,
    competitorReels: (store.competitorReels || []).map(normalizeReel),
    news,
    charts: {
      trend: series,
      hooks: hookStats,
      pillars: pillarStats,
      heatmap
    },
    suggestions: fallbackSuggestions({ competitors: competitorRows, charts: { pillars: pillarStats }, news }),
    summary: {
      posts: filtered.length,
      avgEngagementRate: sum(filtered, "views") > 0
        ? fmtPercent(((sum(filtered, "likes") + sum(filtered, "comments") + sum(filtered, "shares") + sum(filtered, "saves")) / sum(filtered, "views")) * 100, 2)
        : "0%"
    }
  };
}

async function decorateDashboard(store, dashboard) {
  const decorations = await withTimeout(generateDashboardDecorations(store, dashboard).catch(() => null), 8000);
  if (!decorations) return dashboard;
  const news = dashboard.news.map((story) => {
    const blueprint = decorations.blueprints.get(String(story.id));
    if (!blueprint) return story;
    return {
      ...story,
      reelBlueprint: {
        angle: blueprint.angle || story.reelBlueprint?.angle || story.summary,
        hooks: blueprint.hooks?.length ? blueprint.hooks : story.reelBlueprint?.hooks || [],
        structure: blueprint.structure?.length ? blueprint.structure : story.reelBlueprint?.structure || [],
        cta: blueprint.cta || story.reelBlueprint?.cta || "Follow for more niche-specific business and creator signals."
      }
    };
  });
  return {
    ...dashboard,
    header: {
      ...dashboard.header,
      title: decorations.header?.title || dashboard.header.title,
      subtitle: decorations.header?.subtitle || dashboard.header.subtitle
    },
    insights: decorations.insights?.length
      ? decorations.insights.map((item, index) => ({
          ...dashboard.insights[index],
          ...item,
          citation: dashboard.insights[index]?.citation || { view: "performance", section: "insights", label: "AI insights" }
        }))
      : dashboard.insights,
    suggestions: decorations.suggestions?.length ? decorations.suggestions : dashboard.suggestions,
    news
  };
}

function buildContextSummary(dashboard) {
  const trend = dashboard.charts.trend.slice(-7);
  const hookLeader = dashboard.charts.hooks[0];
  const pillarLeader = dashboard.charts.pillars[0];
  const topCompetitor = dashboard.competitors[0];
  return {
    creator: dashboard.creator,
    kpis: dashboard.kpis.map((kpi) => `${kpi.label}: ${kpi.value} (${kpi.delta})`).join("; "),
    trend,
    hookLeader,
    pillarLeader,
    topReel: dashboard.topReels[0],
    topCompetitor,
    topNews: dashboard.news[0],
    transcriptContext: dashboard.transcriptContext || []
  };
}

function liveAiProviderLabel(store) {
  const winster = winsterConfig(store);
  if (chatProvider === "winster" || winster.enabled) {
    return `Winster${winster.model ? ` (${winster.model})` : ""}`;
  }
  if (geminiApiKey) return `Live Gemini (${geminiModel})`;
  if (process.env.OPENAI_API_KEY) return `Live OpenAI (${openAiModel})`;
  return "Rule-based fallback";
}

function normalizeChatStoryContext(story) {
  if (!story || typeof story !== "object") return null;
  return {
    id: String(story.id || ""),
    headline: String(story.headline || ""),
    summary: String(story.summary || ""),
    source: String(story.source || ""),
    publishedAt: String(story.publishedAt || ""),
    age: String(story.age || ""),
    topic: String(story.topic || ""),
    nicheFitLabel: String(story.nicheFitLabel || ""),
    recommendationLabel: String(story.recommendationLabel || ""),
    matchedSignals: Array.isArray(story.matchedSignals) ? story.matchedSignals.map((item) => String(item || "")) : [],
    url: String(story.url || ""),
    reelBlueprint: story.reelBlueprint && typeof story.reelBlueprint === "object"
      ? {
          angle: String(story.reelBlueprint.angle || ""),
          hooks: Array.isArray(story.reelBlueprint.hooks) ? story.reelBlueprint.hooks.map((item) => String(item || "")) : [],
          structure: Array.isArray(story.reelBlueprint.structure) ? story.reelBlueprint.structure.map((item) => String(item || "")) : [],
          cta: String(story.reelBlueprint.cta || "")
        }
      : null
  };
}

function compactChatText(value, limit = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
}

function chatKeywords(value) {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4)
  )];
}

function reelTranscriptText(reel) {
  const timestamped = normalizeTimestampedTranscript(reel.timestampedTranscript)
    .map((segment) => segment.text)
    .join(" ");
  const scenes = Array.isArray(reel.sceneBreakdown)
    ? reel.sceneBreakdown.map((scene) => scene?.text || "").join(" ")
    : "";
  const scriptSummary = Array.isArray(reel.scriptSummary) ? reel.scriptSummary.join(" ") : "";
  return compactChatText([reel.transcript, timestamped, scriptSummary, scenes, reel.caption].filter(Boolean).join(" "), 700);
}

function buildChatTranscriptContext(store, dashboard, prompt, selectedStory = null) {
  const queryText = [
    prompt,
    selectedStory?.headline,
    selectedStory?.summary,
    selectedStory?.topic,
    selectedStory?.matchedSignals?.join(" ")
  ].filter(Boolean).join(" ");
  const queryTokens = chatKeywords(queryText);
  const topIds = new Set((dashboard.topReels || []).slice(0, 8).map((reel) => String(reel.id)));

  return (store.reels || [])
    .map(normalizeReel)
    .map((reel) => {
      const transcript = reelTranscriptText(reel);
      if (!transcript) return null;
      const haystack = [
        reel.title,
        reel.caption,
        reel.hook,
        reel.pillar,
        transcript
      ].join(" ").toLowerCase();
      const keywordScore = queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
      const score = keywordScore * 10
        + (topIds.has(String(reel.id)) ? 8 : 0)
        + Math.min(8, Number(reel.views || 0) / 100000);
      return {
        id: reel.id,
        title: compactChatText(reel.title || reel.caption || "Untitled reel", 90),
        postedAt: reel.postedAt,
        hook: reel.hook,
        pillar: reel.pillar,
        views: reel.views,
        engagementRate: reel.engagementRate,
        transcript,
        score
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .map(({ score, ...item }) => item);
}

function isNewsScriptRequest(prompt, selectedStory = null) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  const mentionsScript = query.includes("script") || query.includes("ready-to-record") || query.includes("ready to record");
  const mentionsReel = query.includes("reel") || query.includes("news story") || query.includes("turn this");
  return Boolean(selectedStory?.headline) && (mentionsScript || mentionsReel);
}

function isNewsScriptFollowUp(prompt, selectedStory = null) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!selectedStory?.headline || !query) return false;
  return /^option\s*[123]$/.test(query)
    || /^(1|2|3)$/.test(query)
    || query === "ok do"
    || query === "do it"
    || query === "do the best thing according to u"
    || query.includes("make the script")
    || query.includes("from the reels news")
    || query.includes("best thing")
    || query.includes("best one")
    || query.includes("best option");
}

function selectedHookIndex(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  const match = query.match(/option\s*([123])/) || query.match(/^([123])$/);
  if (!match) return null;
  return Number(match[1]) - 1;
}

function chatNewsAnswer(story, fallbackHeadline = "this story", preferredHookIndex = null, transcriptContext = []) {
  const blueprint = story?.reelBlueprint;
  const headline = story?.headline || fallbackHeadline;
  const summary = story?.summary || "Explain the headline in one sharp line.";
  const hooks = Array.isArray(blueprint?.hooks) ? blueprint.hooks.filter(Boolean) : [];
  const safeHookIndex = Number.isInteger(preferredHookIndex) && hooks[preferredHookIndex] ? preferredHookIndex : 0;
  const hook = hooks[safeHookIndex] || hooks[0] || "Everyone is reading this headline wrong.";
  const angle = blueprint?.angle || summary;
  const referenceReel = Array.isArray(transcriptContext) ? transcriptContext[0] : null;
  const learnedPattern = referenceReel
    ? `Pattern learned from "${referenceReel.title}": ${compactChatText(referenceReel.transcript, 190)}`
    : "";
  const whyItMatters = String(blueprint?.structure?.[2] || "Connect the update to business, D2C, or creator behavior.")
    .replace(/^Why it matters:\s*/i, "");
  const takeaway = String(blueprint?.structure?.[3] || "Give one clear opinion or prediction.")
    .replace(/^Takeaway:\s*/i, "");
  const cta = blueprint?.cta || "Follow for more high-signal niche breakdowns.";
  return [
    `Reel brief for "${headline}"`,
    `Hook: ${hook}`,
    `Angle: ${angle}`,
    learnedPattern,
    `Script: ${hook} ${summary} Why this matters: ${whyItMatters} My take: ${takeaway} ${cta}`,
    "Delivery: 35-45 sec, direct-to-camera, one bold text overlay in the first frame, tight cuts every 2-3 sec."
  ].filter(Boolean).join("\n\n");
}

function fallbackChat(prompt, dashboard, selectedStory = null) {
  const cleanPrompt = String(prompt || "").trim();
  const query = cleanPrompt.toLowerCase();
  const context = buildContextSummary(dashboard);

  if (!cleanPrompt || cleanPrompt.length < 6) {
    return {
      answer: `Your message is too short to answer properly from analytics. Ask something specific like:\n- Why did my last reel underperform?\n- What should I post next?\n- Which competitor angle is moving fastest?\n- Turn the top news story into a reel angle.`,
      citations: []
    };
  }

  if (query.includes("underperform") || query.includes("last reel")) {
    return {
      answer: `Your weakest pattern right now is lower-retention hooks relative to ${context.hookLeader.label}. The current leader is averaging ${fmtPercent(context.hookLeader.avgRetention)} retention, so underperformers should usually be re-cut around that opening style and published near your highest-scoring time slots.`,
      citations: [dashboard.insights[1]?.citation, dashboard.insights[3]?.citation].filter(Boolean)
    };
  }

  if ((query.includes("why is my") || query.includes("working right now") || query.includes("why is")) && (query.includes("pillar") || query.includes("content") || query.includes("founder story") || query.includes("growth"))) {
    return {
      answer: `${context.pillarLeader.label} is working because it is currently your highest-output pillar, and it is being lifted by ${context.hookLeader.label} style openings. In your saved analytics, that combination is doing the best job of holding attention and concentrating views around the strongest posting slots.`,
      citations: [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation, dashboard.insights[3]?.citation].filter(Boolean)
    };
  }

  if (query.includes("post") && query.includes("next")) {
    return {
      answer: `Next post should stay inside ${context.pillarLeader.label}, use a ${context.hookLeader.label} opener, and target the highest-scoring slot from your heatmap. That combination is currently your cleanest path to both saves and retention.`,
      citations: [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation, dashboard.insights[3]?.citation].filter(Boolean)
    };
  }

  if (query.includes("competitor")) {
    return {
      answer: `${context.topCompetitor.name} is moving fastest at ${context.topCompetitor.monthlyGrowthLabel}. Study the structure of ${context.topCompetitor.bestFormat}, but keep your own trust-led positioning rather than copying their voice directly.`,
      citations: [{ view: "competitors", section: "competitorsTable", label: "Competitor tracker" }]
    };
  }

  if (query.includes("news") || query.includes("reel angle") || query.includes("turn")) {
    const story = selectedStory || context.topNews;
    return {
      answer: chatNewsAnswer(story, context.topNews?.headline, null, context.transcriptContext),
      citations: [{ view: "news", section: "newsGrid", label: "News radar" }]
    };
  }

  if (query.includes("save")) {
    return {
      answer: `${context.hookLeader.label} hooks and ${context.pillarLeader.label} posts are doing the heaviest lifting on saves right now. Those are the clearest formats to double down on when you want conversion-quality attention instead of vanity reach.`,
      citations: [{ view: "performance", section: "hookChart", label: "Hook comparison" }]
    };
  }

  return {
    answer: `I could not map "${cleanPrompt}" to a clear analytics task, so here is the closest grounded summary: ${context.hookLeader.label} is your strongest hook pattern, ${context.pillarLeader.label} is your leading pillar, and ${context.topCompetitor.name} is the fastest-moving competitor. Ask a more specific question about underperformance, next-post planning, competitor breakdown, saves, or reel angles and I will answer more directly.`,
    citations: [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation].filter(Boolean)
  };
}

async function openAiChat(prompt, dashboard, selectedStory = null) {
  if (!process.env.OPENAI_API_KEY) return null;
  const context = buildContextSummary(dashboard);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are a creator analytics assistant. Use only the provided dashboard context, including transcriptContext when present. Treat transcriptContext as examples of the creator's proven wording, hooks, and structure. Be concise and actionable. Do not invent metrics. If a selected story is provided and the user asks for a reel, answer only for that exact story. Return one compact reel brief with these exact blocks: Hook, Angle, Script, Delivery. Do not give multiple options. Do not repeat the same context in different wording."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Context: ${JSON.stringify(context)}\n\nSelected story context: ${JSON.stringify(selectedStory || null)}\n\nQuestion: ${prompt}`
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}`);
  }

  const result = await response.json();
  return {
    answer: result.output_text || "I could not generate an answer from the live model.",
    citations: [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation].filter(Boolean)
  };
}

async function geminiTextInteraction({ prompt, responseFormat = null }) {
  if (!geminiApiKey) return null;
  const payload = {
    model: geminiModel,
    input: [{ type: "text", text: prompt }],
    store: false
  };
  if (responseFormat) payload.response_format = responseFormat;

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini request failed with ${response.status}${details ? `: ${details}` : ""}`);
  }

  return response.json();
}

function interactionOutputText(result) {
  return String(
    result?.output_text ||
      result?.steps
        ?.filter((step) => step?.type === "model_output")
        .flatMap((step) => step?.content || [])
        .map((item) => item?.text || "")
        .join("\n") ||
      result?.output?.[0]?.content?.[0]?.text ||
      result?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") ||
      ""
  ).trim();
}

async function geminiChat(prompt, dashboard, selectedStory = null) {
  if (!geminiApiKey) return null;
  const context = buildContextSummary(dashboard);
  const result = await geminiTextInteraction({
    prompt: [
      "You are a creator analytics assistant.",
      "Use only the provided dashboard context.",
      "Use transcriptContext when present as examples of the creator's proven wording, hooks, and structure.",
      "If selected story context is provided, prioritize that exact story instead of a generic top-news answer.",
      "If the user asks to turn a selected news story into a reel, return one compact reel brief only.",
      "Use exactly these blocks: Hook, Angle, Script, Delivery.",
      "Do not provide multiple hook options.",
      "Do not repeat the headline, angle, and script in slightly different wording.",
      "Keep the answer under 170 words.",
      "Be concise, practical, and grounded in the store data.",
      "Do not invent metrics or claims.",
      "",
      `Context: ${JSON.stringify(context)}`,
      `Selected story context: ${JSON.stringify(selectedStory || null)}`,
      "",
      `Question: ${prompt}`
    ].join("\n")
  });

  return {
    answer: interactionOutputText(result) || "I could not generate an answer from Gemini.",
    citations: [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation].filter(Boolean)
  };
}

function guessMediaExtension(url, contentType = "") {
  const normalizedType = String(contentType || "").toLowerCase();
  if (normalizedType.includes("mp4")) return ".mp4";
  if (normalizedType.includes("mpeg")) return ".mp3";
  if (normalizedType.includes("wav")) return ".wav";
  if (normalizedType.includes("ogg")) return ".ogg";
  if (normalizedType.includes("webm")) return ".webm";
  const pathname = new URL(url, "https://local.invalid").pathname || "";
  const ext = path.extname(pathname);
  return ext || ".mp4";
}

function safeJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  const direct = parseJson(value, null);
  if (direct && typeof direct === "object") return direct;
  const match = String(value).match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  const nested = parseJson(match[0], null);
  return nested && typeof nested === "object" ? nested : fallback;
}

async function fetchMediaFile(reel) {
  if (!reel.mediaUrl) throw new Error("Reel is missing a media URL for transcription.");
  const response = await fetch(reel.mediaUrl);
  if (!response.ok) throw new Error(`Media download failed with ${response.status}`);
  const contentType = response.headers.get("content-type") || "video/mp4";
  const buffer = await response.arrayBuffer();
  const extension = guessMediaExtension(reel.mediaUrl, contentType);
  return new File([buffer], `${reel.id}${extension}`, { type: contentType });
}

async function downloadMediaToTempFile(reel) {
  if (!reel.mediaUrl) throw new Error("Reel is missing a media URL for transcription.");
  const response = await fetch(reel.mediaUrl);
  if (!response.ok) throw new Error(`Media download failed with ${response.status}`);
  const contentType = response.headers.get("content-type") || "video/mp4";
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = guessMediaExtension(reel.mediaUrl, contentType);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "creator-os-whisper-"));
  const filePath = path.join(tempDir, `${reel.id}${extension}`);
  await writeFile(filePath, buffer);
  return { tempDir, filePath, contentType };
}

function localTranscriptionConfig() {
  return {
    provider: transcriptionProvider,
    python: localTranscriptionPython,
    model: localWhisperModel,
    computeType: localWhisperComputeType,
    device: localWhisperDevice,
    language: localWhisperLanguage
  };
}

function transcriptionModeLabel() {
  if (transcriptionProvider === "local") return `Local Whisper (${localWhisperModel})`;
  if (transcriptionProvider === "gemini") return `Gemini Transcription (${geminiModel})`;
  return `OpenAI Transcription (${openAiTranscriptionModel})`;
}

async function transcribeReelMedia(reel) {
  if (transcriptionProvider === "local") {
    return transcribeReelMediaLocally(reel);
  }
  if (transcriptionProvider === "gemini") {
    return transcribeReelMediaWithGemini(reel);
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const mediaFile = await fetchMediaFile(reel);
  const form = new FormData();
  form.append("file", mediaFile);
  form.append("model", openAiTranscriptionModel);
  form.append("response_format", "verbose_json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI transcription failed with ${response.status}${details ? `: ${details}` : ""}`);
  }

  const result = await response.json();
  return {
    transcript: String(result.text || "").trim(),
    segments: Array.isArray(result.segments)
      ? result.segments.map((segment) => ({
          time: `${Math.floor(Number(segment.start || 0))}-${Math.ceil(Number(segment.end || 0))}s`,
          text: String(segment.text || "").trim()
        }))
      : [],
    language: String(result.language || "")
  };
}

async function transcribeReelMediaWithGemini(reel) {
  if (!geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (!reel.mediaUrl) throw new Error("Reel is missing a media URL for transcription.");

  const response = await fetch(reel.mediaUrl);
  if (!response.ok) throw new Error(`Media download failed with ${response.status}`);
  const contentType = response.headers.get("content-type") || "video/mp4";
  const mediaBuffer = Buffer.from(await response.arrayBuffer());
  const inlineBytesLimit = 20 * 1024 * 1024;
  if (mediaBuffer.byteLength > inlineBytesLimit) {
    throw new Error("Gemini inline transcription currently supports media files up to 20 MB. Use local Whisper for larger reels.");
  }

  const result = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey
    },
    body: JSON.stringify({
      model: geminiModel,
      store: false,
      response_format: {
        type: "object",
        properties: {
          transcript: { type: "string" },
          language: { type: "string" },
          segments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                timestamp: { type: "string" },
                content: { type: "string" }
              },
              required: ["timestamp", "content"]
            }
          }
        },
        required: ["transcript", "segments"]
      },
      input: [
        {
          type: contentType.startsWith("audio/") ? "audio" : "video",
          data: mediaBuffer.toString("base64"),
          mime_type: contentType
        },
        {
          type: "text",
          text: [
            "Generate a transcript of this reel.",
            "Return JSON only.",
            "Include:",
            "1. transcript: full plain-text transcript",
            "2. language: primary spoken language code if possible",
            "3. segments: up to 12 timestamped segments with timestamp and content"
          ].join("\n")
        }
      ]
    })
  });

  if (!result.ok) {
    const details = await result.text();
    throw new Error(`Gemini transcription failed with ${result.status}${details ? `: ${details}` : ""}`);
  }

  const payload = safeJsonObject(interactionOutputText(await result.json()), null);
  if (!payload) throw new Error("Gemini transcription returned invalid JSON.");
  return {
    transcript: String(payload.transcript || "").trim(),
    segments: Array.isArray(payload.segments)
      ? payload.segments.slice(0, 12).map((segment, index) => ({
          time: String(segment?.timestamp || `${index + 1}`),
          text: String(segment?.content || "").trim()
        }))
      : [],
    language: String(payload.language || "")
  };
}

async function transcribeReelMediaLocally(reel) {
  const { tempDir, filePath } = await downloadMediaToTempFile(reel);
  const workerPath = path.join(root, "workers", "transcribe.py");
  const config = localTranscriptionConfig();
  try {
    const result = await runPythonJson([
      workerPath,
      "--file",
      filePath,
      "--model",
      config.model,
      "--compute-type",
      config.computeType,
      "--device",
      config.device,
      ...(config.language ? ["--language", config.language] : [])
    ]);
    return {
      transcript: String(result.text || "").trim(),
      segments: Array.isArray(result.segments)
        ? result.segments.map((segment, index) => ({
            time: String(segment?.time || `${index + 1}`),
            text: String(segment?.text || "").trim()
          }))
        : [],
      language: String(result.language || "")
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runPythonJson(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(localTranscriptionPython, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(new Error(`Local transcription worker failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Local transcription worker exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      const result = parseJson(stdout, null);
      if (!result || typeof result !== "object") {
        reject(new Error(`Local transcription worker returned invalid JSON${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(result);
    });
  });
}

function fallbackTranscriptAnalysis(reel, transcript, segments) {
  return {
    pillar: reel.pillar,
    hook: reel.hook,
    tone: reel.tone || "Direct",
    audioType: reel.audioType || "Original voice",
    productionType: reel.productionType || reel.format,
    cta: "Save this and follow for the next breakdown.",
    language: reel.language || "en",
    scriptSummary: fallbackScriptSummary(reel, transcript),
    sceneBreakdown: segments.length ? segments.slice(0, 8) : [
      { time: "0-5s", text: transcript.slice(0, 180) || reel.caption || reel.title },
      { time: "5s+", text: "Transcript imported successfully. Run a deeper analysis pass if you want more granular visual beats." }
    ]
  };
}

function shortTranscriptLine(transcript, fallback = "") {
  const text = String(transcript || fallback || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function fallbackScriptSummary(reel, transcript) {
  const source = String(transcript || reel.caption || reel.title || "").replace(/\s+/g, " ").trim();
  const opening = source ? shortTranscriptLine(source, reel.title) : shortTranscriptLine(reel.title, "Imported reel summary");
  return [
    opening,
    `Main angle: ${String(reel.hook || "Question")} inside ${String(reel.pillar || "General")}.`,
    `Delivery: ${String(reel.audioType || "Original voice")} with ${String(reel.productionType || reel.format || "short-form")} execution.`
  ].filter(Boolean).slice(0, 3);
}

function sanitizeScriptSummary(lines, reel, transcript) {
  const cleaned = Array.isArray(lines)
    ? lines
        .map((line) => String(line || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((line) => (line.length > 180 ? `${line.slice(0, 177)}...` : line))
        .slice(0, 3)
    : [];
  return cleaned.length ? cleaned : fallbackScriptSummary(reel, transcript);
}

function sanitizeShortLabel(value, fallback, maxLength = 48) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  if (text.length <= maxLength) return text;
  const sentence = text.split(/[.,;|]/)[0].trim();
  if (sentence && sentence.length <= maxLength) return sentence;
  const compact = text
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .slice(0, 6)
    .join(" ");
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function analysisNeedsRefinement(analysis) {
  return !Array.isArray(analysis.scriptSummary)
    || !analysis.scriptSummary.length
    || analysis.scriptSummary.some((line) => String(line || "").length > 180)
    || String(analysis.tone || "").length > 60;
}

async function analyzeTranscriptWithOpenAi(reel, transcript, segments) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const compactSegments = segments.slice(0, 12);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You analyze short-form video transcripts for creator analytics. Return JSON only with keys: pillar, hook, tone, audioType, productionType, cta, language, scriptSummary, sceneBreakdown. tone must be 1 short phrase only. scriptSummary must be an array of 3 concise bullet strings. sceneBreakdown must be an array of up to 8 objects with time and text. Do not include markdown fences."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                title: reel.title,
                caption: reel.caption,
                platform: reel.platform,
                format: reel.format,
                transcript,
                segments: compactSegments
              })
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI transcript analysis failed with ${response.status}${details ? `: ${details}` : ""}`);
  }

  const result = await response.json();
  const payload = safeJsonObject(result.output_text, fallbackTranscriptAnalysis(reel, transcript, segments));
  return {
    pillar: String(payload.pillar || reel.pillar || "General"),
    hook: String(payload.hook || reel.hook || "Question"),
    tone: String(payload.tone || "Direct"),
    audioType: String(payload.audioType || "Original voice"),
    productionType: String(payload.productionType || reel.format || "Short video"),
    cta: String(payload.cta || ""),
    language: String(payload.language || reel.language || ""),
    scriptSummary: Array.isArray(payload.scriptSummary)
      ? payload.scriptSummary.map((line) => String(line || "").trim()).filter(Boolean).slice(0, 3)
      : fallbackTranscriptAnalysis(reel, transcript, segments).scriptSummary,
    sceneBreakdown: Array.isArray(payload.sceneBreakdown)
      ? payload.sceneBreakdown.slice(0, 8).map((scene, index) => ({
          time: String(scene?.time || `${index + 1}`),
          text: String(scene?.text || "")
        }))
      : fallbackTranscriptAnalysis(reel, transcript, segments).sceneBreakdown
  };
}

async function analyzeTranscriptWithGemini(reel, transcript, segments) {
  if (!geminiApiKey) throw new Error("GEMINI_API_KEY is not configured.");
  const compactSegments = segments.slice(0, 12);
  const result = await geminiTextInteraction({
    prompt: [
      "You analyze short-form video transcripts for creator analytics.",
      "Return JSON only with keys: pillar, hook, tone, audioType, productionType, cta, language, scriptSummary, sceneBreakdown.",
      "tone must be 1 short phrase only.",
      "scriptSummary must be an array of exactly 3 concise bullet strings.",
      "sceneBreakdown must be an array of up to 8 objects with time and text.",
      "",
      JSON.stringify({
        title: reel.title,
        caption: reel.caption,
        platform: reel.platform,
        format: reel.format,
        transcript,
        segments: compactSegments
      })
    ].join("\n"),
    responseFormat: {
      type: "object",
      properties: {
        pillar: { type: "string" },
        hook: { type: "string" },
        tone: { type: "string" },
        audioType: { type: "string" },
        productionType: { type: "string" },
        cta: { type: "string" },
        language: { type: "string" },
        scriptSummary: {
          type: "array",
          items: { type: "string" }
        },
        sceneBreakdown: {
          type: "array",
          items: {
            type: "object",
            properties: {
              time: { type: "string" },
              text: { type: "string" }
            }
          }
        }
      }
    }
  });

  const payload = safeJsonObject(interactionOutputText(result), fallbackTranscriptAnalysis(reel, transcript, segments));
  return {
    pillar: sanitizeShortLabel(payload.pillar, reel.pillar || "General", 40),
    hook: sanitizeShortLabel(payload.hook, reel.hook || "Question", 72),
    tone: sanitizeShortLabel(payload.tone, "Direct", 40),
    audioType: sanitizeShortLabel(payload.audioType, "Original voice", 32),
    productionType: sanitizeShortLabel(payload.productionType, reel.format || "Short video", 40),
    cta: String(payload.cta || ""),
    language: String(payload.language || reel.language || ""),
    scriptSummary: sanitizeScriptSummary(payload.scriptSummary, reel, transcript),
    sceneBreakdown: Array.isArray(payload.sceneBreakdown)
      ? payload.sceneBreakdown.slice(0, 8).map((scene, index) => ({
          time: String(scene?.time || `${index + 1}`),
          text: String(scene?.text || "")
        }))
      : fallbackTranscriptAnalysis(reel, transcript, segments).sceneBreakdown
  };
}

async function refineGeminiSummary(reel, transcript) {
  if (!geminiApiKey) return null;
  const result = await geminiTextInteraction({
    prompt: [
      "Summarize this creator reel analysis.",
      "Return JSON only with keys: tone and scriptSummary.",
      "tone must be 1 short phrase, max 4 words.",
      "scriptSummary must be an array of exactly 3 short bullet strings.",
      "",
      JSON.stringify({
        title: reel.title,
        caption: reel.caption,
        transcript
      })
    ].join("\n"),
    responseFormat: {
      type: "object",
      properties: {
        tone: { type: "string" },
        scriptSummary: {
          type: "array",
          items: { type: "string" }
        }
      }
    }
  });
  const payload = safeJsonObject(interactionOutputText(result), null);
  if (!payload) return null;
  return {
    tone: sanitizeShortLabel(payload.tone, reel.tone || "Direct", 40),
    scriptSummary: sanitizeScriptSummary(payload.scriptSummary, reel, transcript)
  };
}

async function enrichReelCollection(store, collectionKey = "reels", options = {}) {
  if (transcriptionProvider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY in the environment before running OpenAI transcription, or switch TRANSCRIPTION_PROVIDER=local.");
  }
  if (transcriptionProvider === "gemini" && !geminiApiKey) {
    throw new Error("Set GEMINI_API_KEY in the environment before running Gemini transcription, or switch TRANSCRIPTION_PROVIDER=local.");
  }
  const ids = Array.isArray(options.reelIds) ? new Set(options.reelIds.map(String)) : null;
  const limit = clamp(Number(options.limit || 5), 1, 25);
  const force = options.force === true;
  const sourceReels = Array.isArray(store[collectionKey]) ? store[collectionKey] : [];
  const reels = sourceReels.map(normalizeReel);
  const selected = reels.filter((reel) => (!ids || ids.has(reel.id)));
  const queued = [];
  const skipped = [];

  selected.forEach((reel) => {
    const alreadyReady = reel.transcript && reel.sceneBreakdown.length;
    if (!force && alreadyReady) {
      skipped.push({ id: reel.id, title: reel.title, reason: "already_ready" });
      return;
    }
    if (!reel.mediaUrl) {
      skipped.push({ id: reel.id, title: reel.title, reason: "missing_media_url" });
      return;
    }
    queued.push(reel);
  });

  const queue = queued.slice(0, limit);
  if (queued.length > limit) {
    queued.slice(limit).forEach((reel) => {
      skipped.push({ id: reel.id, title: reel.title, reason: "over_limit" });
    });
  }

  if (!queue.length) {
    return { store, processed: 0, updated: 0, failed: [], skipped };
  }

  const nextReels = [...reels];
  const failed = [];
  let updated = 0;

  for (const reel of queue) {
    const index = nextReels.findIndex((item) => item.id === reel.id);
    if (index < 0) continue;
    try {
      const transcription = await transcribeReelMedia(reel);
      let analysis = geminiApiKey
        ? await analyzeTranscriptWithGemini(reel, transcription.transcript, transcription.segments)
        : process.env.OPENAI_API_KEY
          ? await analyzeTranscriptWithOpenAi(reel, transcription.transcript, transcription.segments)
          : fallbackTranscriptAnalysis(reel, transcription.transcript, transcription.segments);
      if (geminiApiKey && analysisNeedsRefinement(analysis)) {
        const refined = await refineGeminiSummary(reel, transcription.transcript);
        if (refined) {
          analysis = {
            ...analysis,
            tone: refined.tone || analysis.tone,
            scriptSummary: refined.scriptSummary?.length ? refined.scriptSummary : analysis.scriptSummary
          };
        }
      }
      const providerLabel = transcriptionProvider === "local"
        ? `local-whisper:${localWhisperModel}`
        : transcriptionProvider === "gemini"
          ? `gemini-transcribe:${geminiModel}`
          : `openai-transcribe:${openAiTranscriptionModel}`;
      const analysisProvider = geminiApiKey
        ? `gemini:${geminiModel}`
        : process.env.OPENAI_API_KEY
          ? `openai:${openAiModel}`
          : "local-fallback";
      nextReels[index] = normalizeReel({
        ...reel,
        pillar: analysis.pillar || reel.pillar,
        hook: analysis.hook || reel.hook,
        language: analysis.language || transcription.language || reel.language,
        transcript: transcription.transcript,
        transcriptSource: providerLabel,
        scriptSummary: analysis.scriptSummary,
        tone: analysis.tone,
        audioType: analysis.audioType,
        productionType: analysis.productionType,
        cta: analysis.cta,
        sceneBreakdown: analysis.sceneBreakdown.length ? analysis.sceneBreakdown : transcription.segments,
        analysisStatus: "ready",
        analysisError: "",
        analysisUpdatedAt: new Date().toISOString(),
        analysisProvider
      });
      updated += 1;
    } catch (error) {
      nextReels[index] = normalizeReel({
        ...reel,
        analysisStatus: "error",
        analysisUpdatedAt: new Date().toISOString(),
        analysisProvider: transcriptionProvider === "local"
          ? `local-whisper:${localWhisperModel}`
          : transcriptionProvider === "gemini"
            ? `gemini:${geminiModel}`
            : `openai:${openAiModel}`,
        analysisError: error.message,
        sceneBreakdown: reel.sceneBreakdown
      });
      failed.push({ id: reel.id, title: reel.title, error: error.message });
    }
  }

  const next = sanitizeStorePatch({ [collectionKey]: nextReels }, store);
  await writeStore(next);
  return { store: next, processed: queue.length, updated, failed, skipped };
}

async function enrichReelIntelligence(store, options = {}) {
  return enrichReelCollection(store, "reels", options);
}

async function enrichCompetitorReelIntelligence(store, options = {}) {
  return enrichReelCollection(store, "competitorReels", options);
}

async function winsterChat(prompt, dashboard, store) {
  const config = winsterConfig(store);
  if (!config.enabled || !config.baseUrl) return null;
  const context = buildContextSummary(dashboard);
  const url = `${config.baseUrl.replace(/\/$/, "")}${config.path.startsWith("/") ? config.path : `/${config.path}`}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: config.model || undefined,
      prompt,
      context,
      filters: dashboard.filters
    })
  });

  if (!response.ok) {
    throw new Error(`Winster request failed with ${response.status}`);
  }

  const result = await response.json();
  return {
    answer: result.answer || result.output || result.text || "Winster returned no answer.",
    citations: Array.isArray(result.citations)
      ? result.citations
      : [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation].filter(Boolean)
  };
}

function sanitizeStorePatch(patch, current) {
  const sanitizedApifyPatch = patch.integrations?.apify
    ? Object.fromEntries(Object.entries(patch.integrations.apify).filter(([key]) => key !== "token"))
    : null;
  const sanitizedBrightDataPatch = patch.integrations?.brightData
    ? Object.fromEntries(Object.entries(patch.integrations.brightData).filter(([key]) => key !== "apiKey"))
    : null;
  const sanitizedNewsPatch = patch.integrations?.news
    ? { ...patch.integrations.news }
    : null;
  const sanitizedWinsterPatch = patch.integrations?.winster
    ? Object.fromEntries(Object.entries(patch.integrations.winster).filter(([key]) => key !== "apiKey"))
    : null;
  return {
    ...current,
    creator: patch.creator ? { ...current.creator, ...patch.creator } : current.creator,
    branding: patch.branding ? { ...current.branding, ...patch.branding } : current.branding,
    competitorProfiles: patch.competitorProfiles
      ? patch.competitorProfiles.map(normalizeCompetitorProfile)
      : current.competitorProfiles.map(normalizeCompetitorProfile),
    competitorReels: patch.competitorReels
      ? patch.competitorReels.map(normalizeReel)
      : current.competitorReels.map(normalizeReel),
    assistant: patch.assistant ? sanitizeAssistantPatch(patch.assistant, current.assistant || { threads: [], pinned: [] }) : current.assistant,
    integrations: patch.integrations
      ? {
          ...current.integrations,
          ...patch.integrations,
          apify: sanitizedApifyPatch
            ? { ...current.integrations?.apify, ...sanitizedApifyPatch }
            : current.integrations?.apify,
          brightData: sanitizedBrightDataPatch
            ? { ...current.integrations?.brightData, ...sanitizedBrightDataPatch }
            : current.integrations?.brightData,
          news: sanitizedNewsPatch
            ? { ...current.integrations?.news, ...sanitizedNewsPatch }
            : current.integrations?.news,
          winster: sanitizedWinsterPatch
            ? { ...current.integrations?.winster, ...sanitizedWinsterPatch }
            : current.integrations?.winster
        }
      : current.integrations,
    reels: patch.reels ? patch.reels.map(normalizeReel) : current.reels.map(normalizeReel),
    competitors: patch.competitors ? patch.competitors.map(normalizeCompetitor) : current.competitors.map(normalizeCompetitor),
    news: patch.news ? patch.news.map(normalizeNews) : current.news.map(normalizeNews),
    meta: {
      ...current.meta,
      updatedAt: new Date().toISOString()
    }
  };
}

function mapApifyItemToReel(item) {
  return normalizeReel({
    id: pickValue(item, ["id", "postId", "shortCode", "url", "inputUrl"], `reel-${Math.random().toString(36).slice(2, 8)}`),
    title: deriveReelTitle(item),
    platform: normalizePlatform(pickValue(item, ["platform", "sourcePlatform", "owner.platform"], "instagram")),
    pillar: pickValue(item, ["pillar", "category", "contentPillar", "analysis.pillar"], "Imported"),
    hook: deriveHook(item),
    format: pickValue(item, ["format", "contentType", "mediaType", "type"], "Short video"),
    postedAt: pickValue(item, ["postedAt", "publishedAt", "timestamp", "createTimeISO", "takenAtTimestamp"], new Date().toISOString()),
    views: pickValue(item, ["views", "playCount", "videoViewCount", "videoPlayCount", "insights.views"], 0),
    likes: pickValue(item, ["likes", "likeCount", "likesCount", "edge_media_preview_like.count"], 0),
    comments: pickValue(item, ["comments", "commentCount", "commentsCount", "edge_media_to_comment.count"], 0),
    shares: pickValue(item, ["shares", "shareCount", "insights.shares"], 0),
    saves: pickValue(item, ["saves", "saveCount", "insights.saves"], 0),
    retention: pickValue(item, ["retention", "watchPct", "averageWatchPercentage", "insights.retention"], 0),
    watchTime: pickValue(item, ["watchTime", "avgWatchTime", "videoDuration", "insights.watchTime"], 0),
    followersGained: pickValue(item, ["followersGained", "followerGain", "insights.followersGained"], 0),
    url: pickValue(item, ["url", "postUrl", "inputUrl", "permalink"], ""),
    mediaUrl: pickValue(item, [
      "downloadedVideo",
      "downloaded_video",
      "downloadedVideoUrl",
      "downloaded_video_url",
      "videoUrl",
      "video_url",
      "videoPlayUrl",
      "video_play_url",
      "downloadUrl",
      "download_url",
      "mediaUrl",
      "media_url",
      "videoVersions.0.url",
      "video_versions.0.url",
      "clipsMetadata.originalVideoUrl",
      "clips_metadata.original_video_url"
    ], ""),
    thumbnailUrl: pickValue(item, ["thumbnailUrl", "displayUrl", "coverUrl", "imageUrl"], ""),
    caption: pickValue(item, ["caption", "text", "description", "postText"], ""),
    language: pickValue(item, ["language", "lang"], ""),
    sourceHandle: pickValue(item, ["ownerUsername", "username", "owner.username"], ""),
    collabLabel: pickValue(item, ["collabLabel", "isCollab", "partnershipLabel"], ""),
    transcript: pickValue(item, ["transcript", "videoTranscript"], ""),
    audioType: pickValue(item, ["musicInfo.song_name", "audioTrackTitle"], ""),
    productionType: pickValue(item, ["productType", "contentType"], ""),
    sourceFollowers: pickValue(item, ["ownerFollowersCount", "owner.followersCount", "owner.followedBy.count", "author.followers"], 0),
    sourceName: pickValue(item, ["ownerFullName", "owner.fullName", "author.name"], "")
  });
}

function mapApifyItemToNews(item) {
  return normalizeNews({
    id: pickValue(item, ["id", "url", "canonicalUrl"], `news-${Math.random().toString(36).slice(2, 8)}`),
    source: pickValue(item, ["source", "publisher", "domain", "siteName"], "Apify import"),
    headline: pickValue(item, ["headline", "title", "name"], "Imported story"),
    summary: pickValue(item, ["summary", "description", "snippet", "text"], ""),
    publishedAt: pickValue(item, ["publishedAt", "timestamp", "pubDate", "datePublished"], new Date().toISOString()),
    relevance: pickValue(item, ["relevance", "score", "rank"], 70),
    topic: pickValue(item, ["topic", "category", "section"], "Imported"),
    url: pickValue(item, ["url", "canonicalUrl", "link"], ""),
    sourceType: "apify",
    importedAt: new Date().toISOString()
  });
}

function flattenBrightDataItems(items) {
  const flattened = [];
  items.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const nested = [
      ...(Array.isArray(item.reels) ? item.reels : []),
      ...(Array.isArray(item.posts) ? item.posts.filter((post) => /reel|video/i.test(String(post?.type || post?.media_type || ""))) : []),
      ...(Array.isArray(item.latest_posts) ? item.latest_posts.filter((post) => /reel|video/i.test(String(post?.type || post?.media_type || ""))) : []),
    ];
    if (nested.length) {
      nested.forEach((child) => flattened.push({ ...item, ...child, profile: item }));
      return;
    }
    flattened.push(item);
  });
  return flattened;
}

function mapBrightDataItemToReel(item) {
  const ownerHandle = pickValue(item, ["username", "owner.username", "profile.username", "account.username"], "");
  const ownerName = pickValue(item, ["full_name", "owner.full_name", "profile.full_name", "account.full_name"], "");
  return normalizeReel({
    id: pickValue(item, ["id", "post_id", "pk", "code", "shortcode", "short_code", "url"], `reel-${Math.random().toString(36).slice(2, 8)}`),
    title: deriveReelTitle(item),
    platform: "instagram",
    pillar: pickValue(item, ["pillar", "category", "topic"], "Imported"),
    hook: deriveHook(item),
    format: pickValue(item, ["format", "type", "media_type", "product_type"], "Reel"),
    postedAt: pickValue(item, ["posted_at", "timestamp", "taken_at_timestamp", "created_at"], new Date().toISOString()),
    views: pickValue(item, ["views", "play_count", "video_view_count", "video_play_count"], 0),
    likes: pickValue(item, ["likes", "likes_count", "like_count"], 0),
    comments: pickValue(item, ["comments", "comments_count", "comment_count"], 0),
    shares: pickValue(item, ["shares", "share_count"], 0),
    saves: pickValue(item, ["saves", "save_count"], 0),
    retention: pickValue(item, ["retention", "watch_pct"], 0),
    watchTime: pickValue(item, ["watch_time", "video_duration", "duration"], 0),
    followersGained: pickValue(item, ["followers_gained", "follower_gain"], 0),
    url: pickValue(item, ["url", "post_url", "permalink"], ""),
    mediaUrl: pickValue(item, ["video_url", "media_url", "download_url"], ""),
    thumbnailUrl: pickValue(item, ["thumbnail_url", "display_url", "image_url"], ""),
    caption: pickValue(item, ["caption", "description", "text"], ""),
    language: pickValue(item, ["language", "lang"], ""),
    sourceHandle: ownerHandle,
    collabLabel: pickValue(item, ["collab_label", "partnership_label"], ""),
    transcript: pickValue(item, ["transcript", "video_transcript"], ""),
    audioType: pickValue(item, ["audio_track_title", "music_info.song_name"], ""),
    productionType: pickValue(item, ["product_type", "content_type"], ""),
    sourceFollowers: pickValue(item, ["followers_count", "owner.followers_count", "profile.followers_count"], 0),
    sourceName: ownerName
  });
}

function looksLikeApifyReelDataset(payload) {
  return Array.isArray(payload) && payload.some((item) => item && typeof item === "object" && ("shortCode" in item || "ownerUsername" in item || "videoUrl" in item));
}

function normalizeApifyImportInput(input = {}, strategy = "reels") {
  const base = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  if (strategy === "news") return base;

  const normalized = { ...base };
  normalized.resultsLimit = clamp(Number(normalized.resultsLimit || 5), 1, 100);
  normalized.skipPinnedPosts = normalized.skipPinnedPosts !== false;
  normalized.includeTranscript = normalized.includeTranscript === true;
  normalized.includeDownloadedVideo = normalized.includeDownloadedVideo === true;

  if (Array.isArray(normalized.username)) {
    normalized.username = normalized.username
      .map((value) => String(value || "").trim().replace(/^@/, ""))
      .filter(Boolean)
      .slice(0, 1);
  }

  if (Array.isArray(normalized.directUrls)) {
    normalized.directUrls = normalized.directUrls
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 5);
  }

  if (!normalized.username?.length && !normalized.directUrls?.length && !normalized.urls?.length) {
    throw new Error("Apify import needs at least one username or direct reel URL.");
  }

  return normalized;
}

function restrictImportedReelsToCreator(reels, store, config) {
  const requestedHandle = String(config.input?.username?.[0] || "").replace(/^@/, "").trim().toLowerCase();
  const creatorHandle = requestedHandle || inferPrimaryCreatorHandle(store) || String(store.creator?.handle || "").replace(/^@/, "").trim().toLowerCase();
  if (!creatorHandle) {
    return { reels, creatorHandle: "", skippedForeign: 0 };
  }

  const kept = [];
  let skippedForeign = 0;
  reels.forEach((reel) => {
    const handle = String(reel.sourceHandle || "").trim().toLowerCase();
    if (!handle || handle === creatorHandle) {
      kept.push(reel);
      return;
    }
    skippedForeign += 1;
  });
  return { reels: kept, creatorHandle, skippedForeign };
}

async function runApifyImport(store, override = {}) {
  const base = apifyConfig(store);
  const strategy = override.strategy || "reels";
  const config = {
    ...base,
    ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)),
    input: normalizeApifyImportInput(override.input !== undefined ? override.input : base.input, strategy)
  };
  if (!config.token) throw new Error("Apify token is not configured.");
  const isTask = config.mode === "task";
  const targetId = isTask ? config.taskId : config.actorId;
  if (!config.datasetId && !targetId) throw new Error(`Apify ${isTask ? "task" : "actor"} ID is not configured.`);

  const items = await fetchApifyItems(config, config.input || {});
  const mapped = strategy === "news"
    ? { news: items.map(mapApifyItemToNews) }
    : { reels: items.map(mapApifyItemToReel) };
  const restricted = mapped.reels
    ? restrictImportedReelsToCreator(mapped.reels, store, config)
    : null;
  const finalReels = restricted?.reels || mapped.reels;
  const nextReels = mapped.reels ? mergeReelsById(store.reels || [], mapped.reels) : null;
  const nextMergedReels = finalReels ? mergeReelsById(store.reels || [], finalReels) : null;
  const importedReels = finalReels?.length || 0;
  const addedReels = nextMergedReels ? Math.max(0, nextMergedReels.length - (store.reels || []).length) : 0;

  const next = sanitizeStorePatch({
    ...mapped,
    reels: nextMergedReels || finalReels,
    integrations: {
      apify: {
        ...config,
        lastRunAt: new Date().toISOString()
      }
    }
  }, store);
  await writeStore(next);
  return {
    store: next,
    importedCounts: {
      reels: addedReels || importedReels,
      news: mapped.news?.length || 0
    },
    skippedCounts: {
      duplicates: importedReels ? Math.max(0, importedReels - addedReels) : 0,
      foreign: restricted?.skippedForeign || 0
    }
  };
}

async function runBrightDataImport(store, override = {}) {
  const base = brightDataConfig(store);
  const config = {
    ...base,
    ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)),
    input: override.input !== undefined ? override.input : base.input
  };
  if (!config.apiKey) throw new Error("Bright Data API key is not configured.");
  if (!config.datasetId) throw new Error("Bright Data dataset ID is not configured.");
  if (!Array.isArray(config.input) || !config.input.length) {
    throw new Error("Bright Data input must be a non-empty array.");
  }

  const items = await fetchBrightDataItems(config);
  const reels = flattenBrightDataItems(items).map(mapBrightDataItemToReel);
  const next = sanitizeStorePatch({
    reels: mergeReelsById(store.reels || [], reels),
    integrations: {
      brightData: {
        ...config,
        lastRunAt: new Date().toISOString()
      }
    }
  }, store);
  await writeStore(next);
  return {
    store: next,
    importedCounts: {
      reels: reels.length,
      news: 0
    }
  };
}

async function fetchBrightDataItems(config) {
  const snapshotId = await triggerBrightDataSnapshot(config);
  await waitForBrightDataSnapshot(config, snapshotId);
  return downloadBrightDataSnapshot(config, snapshotId);
}

async function triggerBrightDataSnapshot(config) {
  const endpoint = `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${encodeURIComponent(config.datasetId)}&include_errors=true`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(config.input)
  });
  const payload = parseJson(await response.text(), null);
  if (!response.ok) {
    throw new Error(`Bright Data trigger failed with ${response.status}${payload ? `: ${JSON.stringify(payload)}` : ""}`);
  }
  const snapshotId = payload?.snapshot_id || payload?.snapshotId;
  if (!snapshotId) throw new Error("Bright Data did not return a snapshot ID.");
  return snapshotId;
}

async function waitForBrightDataSnapshot(config, snapshotId) {
  const endpoint = `https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(snapshotId)}`;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      }
    });
    const payload = parseJson(await response.text(), null);
    if (!response.ok) {
      throw new Error(`Bright Data progress check failed with ${response.status}${payload ? `: ${JSON.stringify(payload)}` : ""}`);
    }
    const status = String(payload?.status || "").toLowerCase();
    if (status === "ready") return;
    if (["failed", "error", "aborted"].includes(status)) {
      throw new Error(`Bright Data run ended with status: ${payload?.status || "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("Bright Data snapshot timed out before completion.");
}

async function downloadBrightDataSnapshot(config, snapshotId) {
  const endpoint = `https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    }
  });
  const payload = parseJson(await response.text(), null);
  if (!response.ok) {
    throw new Error(`Bright Data snapshot download failed with ${response.status}${payload ? `: ${JSON.stringify(payload)}` : ""}`);
  }
  if (!Array.isArray(payload)) throw new Error("Bright Data snapshot did not return an array.");
  return payload;
}

async function fetchApifyItems(config, input) {
  if (config.datasetId) {
    const datasetUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(config.datasetId)}/items?token=${encodeURIComponent(config.token)}&clean=true`;
    const response = await fetch(datasetUrl);
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Apify dataset fetch failed with ${response.status}${details ? `: ${details}` : ""}`);
    }
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error("Apify dataset did not return items.");
    return items;
  }

  const isTask = config.mode === "task";
  const targetId = isTask ? config.taskId : config.actorId;
  if (!targetId) throw new Error(`Apify ${isTask ? "task" : "actor"} ID is not configured.`);

  const endpoint = isTask
    ? `https://api.apify.com/v2/actor-tasks/${encodeURIComponent(targetId)}/run-sync-get-dataset-items?token=${encodeURIComponent(config.token)}`
    : `https://api.apify.com/v2/actors/${encodeURIComponent(targetId)}/run-sync-get-dataset-items?token=${encodeURIComponent(config.token)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input || {})
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Apify import failed with ${response.status}${details ? `: ${details}` : ""}`);
  }

  const items = await response.json();
  if (!Array.isArray(items)) throw new Error("Apify sync run did not return dataset items.");
  return items;
}

async function fetchApifyProfileItems(config, handles) {
  const actorId = String(config.profileActorId || "").trim();
  if (!config.token || !actorId || !Array.isArray(handles) || !handles.length) return [];

  const cleanHandles = [...new Set(handles.map((handle) => String(handle || "").replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];
  if (!cleanHandles.length) return [];

  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(config.token)}`;
  const candidates = [
    { usernames: cleanHandles },
    { username: cleanHandles },
    cleanHandles,
    { directUrls: cleanHandles.map((handle) => `https://www.instagram.com/${handle}/`) },
  ];

  let lastError = null;
  for (const body of candidates) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      lastError = await response.text();
      continue;
    }
    const items = await response.json();
    if (Array.isArray(items) && items.length) return items;
    if (Array.isArray(items)) return items;
  }

  if (lastError) {
    throw new Error(`Apify profile import failed: ${lastError}`);
  }
  return [];
}

function mergeReelsById(existing, incoming) {
  const byId = new Map(existing.map((reel) => [String(reel.id), normalizeReel(reel)]));
  incoming.forEach((reel) => {
    const incomingReel = normalizeReel(reel);
    const current = byId.get(String(reel.id));
    if (!current) {
      byId.set(String(reel.id), incomingReel);
      return;
    }

    const keepExistingAnalysis = hasTranscriptPayload(current);
    const incomingHasAnalysis = hasTranscriptPayload(incomingReel);

    byId.set(
      String(reel.id),
      normalizeReel({
        ...current,
        ...incomingReel,
        transcript: incomingHasAnalysis ? incomingReel.transcript : current.transcript,
        timestampedTranscript: incomingHasAnalysis && incomingReel.timestampedTranscript.length
          ? incomingReel.timestampedTranscript
          : current.timestampedTranscript,
        transcriptSource: incomingHasAnalysis ? incomingReel.transcriptSource : current.transcriptSource,
        scriptSummary: incomingHasAnalysis && incomingReel.scriptSummary.length ? incomingReel.scriptSummary : current.scriptSummary,
        sceneBreakdown: incomingHasAnalysis && incomingReel.sceneBreakdown.length ? incomingReel.sceneBreakdown : current.sceneBreakdown,
        language: incomingReel.language || current.language,
        audioType: incomingReel.audioType || current.audioType,
        tone: incomingReel.tone || current.tone,
        productionType: incomingReel.productionType || current.productionType,
        cta: incomingReel.cta || current.cta,
        analysisStatus: incomingHasAnalysis ? incomingReel.analysisStatus : keepExistingAnalysis ? current.analysisStatus : incomingReel.analysisStatus,
        analysisError: incomingHasAnalysis ? incomingReel.analysisError : current.analysisError,
        analysisUpdatedAt: incomingHasAnalysis ? incomingReel.analysisUpdatedAt : current.analysisUpdatedAt,
        analysisProvider: incomingHasAnalysis ? incomingReel.analysisProvider : current.analysisProvider
      })
    );
  });
  return [...byId.values()];
}

function mapApifyProfileItem(item) {
  const username = String(pickValue(item, ["username", "userName", "ownerUsername", "account.username"], "")).replace(/^@/, "").trim().toLowerCase();
  return {
    handle: username,
    name: pickValue(item, ["fullName", "full_name", "name", "ownerFullName", "account.full_name"], username || "Unnamed competitor"),
    followers: pickValue(item, ["followersCount", "followers", "followers_count", "edge_followed_by.count"], 0),
    profileUrl: pickValue(item, ["url", "profileUrl", "inputUrl"], username ? `https://www.instagram.com/${username}/` : ""),
    lastProfileScrapedAt: new Date().toISOString()
  };
}

function parseInstagramFollowerCountFromHtml(html) {
  const patterns = [
    /"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i,
    /"followers_count"\s*:\s*(\d+)/i,
    /"og:description"\s+content="([\d.,]+)\s+Followers/i,
    /"meta"\s+property="og:description"\s+content="([\d.,]+)\s+Followers/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const raw = String(match[1] || "").replace(/[^\d.]/g, "");
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  return 0;
}

async function fetchInstagramProfileSnapshot(handle) {
  const cleanHandle = String(handle || "").replace(/^@/, "").trim().toLowerCase();
  if (!cleanHandle) throw new Error("Missing Instagram handle.");

  const response = await fetch(`https://www.instagram.com/${encodeURIComponent(cleanHandle)}/`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.instagram.com/"
    }
  });

  if (!response.ok) {
    throw new Error(`Instagram profile fetch failed with ${response.status}`);
  }

  const html = await response.text();
  const followers = parseInstagramFollowerCountFromHtml(html);
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const name = String(titleMatch?.[1] || "")
    .replace(/\(@[^)]+\).*/i, "")
    .replace(/\s*•\s*Instagram.*$/i, "")
    .trim();

  return {
    handle: cleanHandle,
    followers,
    name,
    profileUrl: `https://www.instagram.com/${cleanHandle}/`,
    lastProfileScrapedAt: new Date().toISOString()
  };
}

async function runCompetitorImport(store, options = {}) {
  const profiles = (store.competitorProfiles || []).map(normalizeCompetitorProfile).filter((profile) => profile.handle);
  if (!profiles.length) throw new Error("Add competitor handles first.");

  const config = apifyConfig(store);
  if (!config.token || !config.actorId) throw new Error("Apify actor config is required for competitor import.");

  const limitPerHandle = clamp(Number(options.limitPerHandle || 3), 1, 5);
  const collected = [];
  const profileByHandle = new Map(profiles.map((profile) => [profile.handle, profile]));
  const failedHandles = [];

  try {
    const profileItems = await fetchApifyProfileItems(config, profiles.map((profile) => profile.handle));
    profileItems
      .map(mapApifyProfileItem)
      .filter((profile) => profile.handle)
      .forEach((profile) => {
        const current = profileByHandle.get(profile.handle) || {};
        profileByHandle.set(profile.handle, normalizeCompetitorProfile({
          ...current,
          ...profile,
          angle: current.angle || profile.angle,
          aliases: current.aliases || []
        }));
      });
  } catch {
    // Fall back to HTML-based profile snapshots below when the profile actor is unavailable.
  }

  for (const profile of profiles) {
    try {
      const items = await fetchApifyItems(config, normalizeApifyImportInput({
        ...(config.input || {}),
        username: [profile.handle],
        resultsLimit: limitPerHandle,
        includeDownloadedVideo: true,
        includeTranscript: false,
        skipPinnedPosts: true
      }));
      collected.push(
        ...items.map((item) =>
          mapApifyItemToReel({
            ...item,
            ownerUsername: item.ownerUsername || profile.handle
          }),
        ),
      );
    } catch (error) {
      failedHandles.push({
        handle: profile.handle,
        error: String(error?.message || error || "Unknown competitor import error")
      });
    }

    if (!Number(profileByHandle.get(profile.handle)?.followers || 0)) {
      try {
        const snapshot = await fetchInstagramProfileSnapshot(profile.handle);
        profileByHandle.set(profile.handle, normalizeCompetitorProfile({
          ...profileByHandle.get(profile.handle),
          handle: profile.handle,
          name: snapshot.name || profile.name,
          followers: snapshot.followers || profile.followers || 0,
          profileUrl: snapshot.profileUrl,
          lastProfileScrapedAt: snapshot.lastProfileScrapedAt
        }));
      } catch {
        profileByHandle.set(profile.handle, normalizeCompetitorProfile({
          ...profileByHandle.get(profile.handle),
          handle: profile.handle
        }));
      }
    }
  }

  const next = sanitizeStorePatch({
    competitorProfiles: [...profileByHandle.values()],
    competitorReels: mergeReelsById(store.competitorReels || [], collected),
    integrations: {
      apify: {
        ...config,
        lastCompetitorRunAt: new Date().toISOString()
      }
    }
  }, store);
  await writeStore(next);
  return {
    store: next,
    importedCounts: {
      competitors: profiles.length,
      reels: Math.max(0, next.competitorReels.length - (store.competitorReels || []).length)
    },
    failedHandles
  };
}

async function runAutoApifyImportCycle() {
  if (apifyAutoImportInFlight) return;
  apifyAutoImportInFlight = true;
  try {
    const store = await readStore();
    const config = apifyConfig(store);
    if (!config.autoImportEnabled || !config.token || !config.actorId) return;

    const username =
      config.autoImportUsername ||
      String(config.input?.username?.[0] || "").replace(/^@/, "").trim().toLowerCase() ||
      inferPrimaryCreatorHandle(store);
    if (!username) return;

    const result = await runApifyImport(store, {
      mode: config.mode,
      actorId: config.actorId,
      taskId: config.taskId,
      strategy: "reels",
      input: {
        ...(config.input || {}),
        username: [username],
        resultsLimit: config.autoImportResultsLimit,
        skipPinnedPosts: true
      }
    });

    const current = await readStore();
    const next = sanitizeStorePatch({
      integrations: {
        apify: {
          ...apifyConfig(current),
          lastAutoImportAt: new Date().toISOString(),
          lastAutoImportStatus: `Imported ${result.importedCounts.reels} reels for @${username}`
        }
      }
    }, current);
    await writeStore(next);
  } catch (error) {
    const current = await readStore();
    const next = sanitizeStorePatch({
      integrations: {
        apify: {
          ...apifyConfig(current),
          lastAutoImportAt: new Date().toISOString(),
          lastAutoImportStatus: `Failed: ${error.message}`
        }
      }
    }, current);
    await writeStore(next);
  } finally {
    apifyAutoImportInFlight = false;
  }
}

function startAutoApifyImportScheduler() {
  if (apifyAutoImportTimer) clearInterval(apifyAutoImportTimer);
  readStore()
    .then((store) => {
      const config = apifyConfig(store);
      if (!config.autoImportEnabled) return;
      const intervalMs = config.autoImportIntervalMinutes * 60 * 1000;
      apifyAutoImportTimer = setInterval(() => {
        runAutoApifyImportCycle().catch(() => {});
      }, intervalMs);
      setTimeout(() => {
        runAutoApifyImportCycle().catch(() => {});
      }, 15000);
    })
    .catch(() => {});
}

async function handleAdminImport(body, current) {
  if (body.source === "apify") {
    const result = await runApifyImport(current, {
      mode: body.mode,
      actorId: body.actorId,
      taskId: body.taskId,
      token: body.token,
      input: body.input,
      strategy: body.strategy
    });
    return {
      status: 200,
      payload: {
        ok: true,
        source: "apify",
        importedCounts: result.importedCounts,
        store: publicStore(result.store)
      }
    };
  }

  if (body.source === "brightdata") {
    const result = await runBrightDataImport(current, {
      datasetId: body.datasetId,
      apiKey: body.apiKey,
      input: body.input
    });
    return {
      status: 200,
      payload: {
        ok: true,
        source: "brightdata",
        importedCounts: result.importedCounts,
        store: publicStore(result.store)
      }
    };
  }

  const imported = typeof body.payload === "string" ? parseJson(body.payload, null) : body.payload;
  if (!imported || typeof imported !== "object") {
    return {
      status: 422,
      payload: { error: "Import payload must be valid JSON." }
    };
  }
  const normalizedImport = looksLikeApifyReelDataset(imported)
    ? {
        creator: imported[0]
          ? {
              name: pickValue(imported[0], ["ownerFullName", "owner.full_name"], current.creator?.name || ""),
              niche: current.creator?.niche || ""
            }
          : current.creator,
        reels: imported.map(mapApifyItemToReel)
      }
    : imported;
  const next = sanitizeStorePatch(normalizedImport, current);
  await writeStore(next);
  return {
    status: 200,
    payload: {
      ok: true,
      source: "json",
      counts: {
        reels: next.reels.length,
        competitors: next.competitors.length,
        news: next.news.length
      },
      store: publicStore(next)
    }
  };
}

async function handleCompetitorImport(body, current) {
  const result = await runCompetitorImport(current, body || {});
  return {
    status: 200,
    payload: {
      ok: true,
      importedCounts: result.importedCounts,
      store: publicStore(result.store)
    }
  };
}

async function handleLiveNewsImport(body, current) {
  const result = await runLiveNewsImport(current, body || {});
  return {
    status: 200,
    payload: {
      ok: true,
      importedCounts: result.importedCounts,
      queries: result.queries,
      store: publicStore(result.store)
    }
  };
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost:8787");

  try {
    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      const store = await readStore();
      const dashboard = await decorateDashboard(store, computeDashboard(store, Object.fromEntries(url.searchParams.entries())));
      return replyJson(response, 200, dashboard);
    }

    if (url.pathname === "/api/chart-series" && request.method === "GET") {
      const dashboard = computeDashboard(await readStore(), Object.fromEntries(url.searchParams.entries()));
      return replyJson(response, 200, dashboard.charts);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (isRateLimited(request, "chat", 40, 60_000)) {
        return replyJson(response, 429, { error: "Too many chat requests. Try again shortly." });
      }
      const body = parseJson(await collectBody(request), {});
      const prompt = String(body.prompt || "").trim();
      const selectedStory = normalizeChatStoryContext(body.storyContext);
      const store = await readStore();
      const dashboard = computeDashboard(store, body.filters || {});
      dashboard.transcriptContext = buildChatTranscriptContext(store, dashboard, prompt, selectedStory);
      if (isNewsScriptRequest(prompt, selectedStory) || isNewsScriptFollowUp(prompt, selectedStory)) {
        return replyJson(response, 200, {
          answer: chatNewsAnswer(selectedStory, dashboard.news?.[0]?.headline, selectedHookIndex(prompt), dashboard.transcriptContext),
          citations: [
            { view: "news", section: "newsGrid", label: "News radar" },
            { view: "performance", section: "allPostsTable", label: "Transcript examples" }
          ]
        });
      }
      let result = null;
      try {
        if (chatProvider === "winster" || winsterConfig(store).enabled) {
          result = await winsterChat(prompt, dashboard, store);
        } else if (geminiApiKey) {
          result = await geminiChat(prompt, dashboard, selectedStory);
        } else {
          result = await openAiChat(prompt, dashboard, selectedStory);
        }
      } catch {
        result = null;
      }
      return replyJson(response, 200, result || fallbackChat(prompt, dashboard, selectedStory));
    }

    if (url.pathname === "/api/assistant/state" && request.method === "GET") {
      const store = await readStore();
      return replyJson(response, 200, store.assistant || { threads: [], pinned: [] });
    }

    if (url.pathname === "/api/assistant/state" && request.method === "POST") {
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const next = sanitizeStorePatch({ assistant: body }, current);
      await writeStore(next);
      return replyJson(response, 200, { ok: true, assistant: next.assistant });
    }

    if (url.pathname === "/api/admin/store" && request.method === "GET") {
      if (!requireAdmin(request, response)) return;
      return replyJson(response, 200, publicStore(await readStore()));
    }

    if (url.pathname === "/api/admin/store" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const next = sanitizeStorePatch(body, current);
      await writeStore(next);
      startAutoApifyImportScheduler();
      return replyJson(response, 200, { ok: true, store: publicStore(next) });
    }

    if (url.pathname === "/api/admin/import" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const result = await handleAdminImport(body, current);
      return replyJson(response, result.status, result.payload);
    }

    if (url.pathname === "/api/admin/competitors/import" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const result = await handleCompetitorImport(body, current);
      return replyJson(response, result.status, result.payload);
    }

    if (url.pathname === "/api/admin/news/import-live" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const result = await handleLiveNewsImport(body, current);
      return replyJson(response, result.status, result.payload);
    }

    if (url.pathname === "/api/admin/apify/run" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const result = await handleAdminImport({ ...body, source: "apify" }, current);
      return replyJson(response, result.status, result.payload);
    }

    if (url.pathname === "/api/admin/reels/enrich" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const result = await enrichReelIntelligence(current, {
        reelIds: body.reelIds,
        limit: body.limit,
        force: body.force
      });
      return replyJson(response, 200, {
        ok: true,
        processed: result.processed,
        updated: result.updated,
        failed: result.failed,
        store: publicStore(result.store)
      });
    }

    if (url.pathname === "/api/admin/competitor-reels/enrich" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const result = await enrichCompetitorReelIntelligence(current, {
        reelIds: body.reelIds,
        limit: body.limit,
        force: body.force
      });
      return replyJson(response, 200, {
        ok: true,
        processed: result.processed,
        updated: result.updated,
        failed: result.failed,
        skipped: result.skipped,
        store: publicStore(result.store)
      });
    }

    if (url.pathname === "/api/admin/reels" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const store = await readStore();
      const incoming = Array.isArray(body.reels) ? body.reels.map(normalizeReel) : [normalizeReel(body)];
      const next = sanitizeStorePatch({ reels: [...store.reels, ...incoming] }, store);
      await writeStore(next);
      return replyJson(response, 201, { ok: true, total: next.reels.length });
    }

    const target = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (publicFiles.has(target)) {
      return serveFile(response, path.join(root, target));
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    replyJson(response, 500, { error: error.message || "Server error." });
  }
}).listen(port, () => {
  console.log(`Creator OS running at http://localhost:${port}`);
  startAutoApifyImportScheduler();
});
