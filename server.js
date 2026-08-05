import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const thumbnailCacheDir = path.join(dataDir, "thumbnails");
const storePath = path.join(dataDir, "store.json");
const businessVideosPath = path.join(dataDir, "business-videos.json");
const sqlitePath = path.join(dataDir, "creator-os.db");
const publicFiles = new Set(["index.html", "app.css", "app.js"]);
const port = Number(process.env.PORT || 8787);
const adminToken = process.env.ADMIN_TOKEN || "";
const adminUsername = process.env.ADMIN_USERNAME || "";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const openAiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const openAiTranscriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-flash-latest";
const geminiModelCandidates = [...new Set([
  geminiModel,
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest"
].filter(Boolean))];
const CREATOR_FOLLOWER_OVERRIDES = new Map([
  ["abvaidya", { followers: 401582, followersLabel: "401,582", source: "Public profile source" }]
]);
const newsLookbackDays = Math.max(1, Math.min(365, Number(process.env.NEWS_LOOKBACK_DAYS || 30)));
const newsQueryLimit = Math.max(5, Math.min(80, Number(process.env.NEWS_QUERY_LIMIT || 60)));
const apifyAutoImportEnabledEnv = String(process.env.APIFY_AUTO_IMPORT_ENABLED || "").toLowerCase() === "true";
const apifyAutoImportIntervalMinutesEnv = Math.max(15, Number(process.env.APIFY_AUTO_IMPORT_INTERVAL_MINUTES || 180));
const apifyAutoImportUsernameEnv = String(process.env.APIFY_AUTO_IMPORT_USERNAME || "").replace(/^@/, "").trim().toLowerCase();
const apifyAutoImportResultsLimitEnv = Math.max(1, Math.min(10, Number(process.env.APIFY_AUTO_IMPORT_RESULTS_LIMIT || 3)));
const apifyMetadataRefreshEnabledEnv = String(process.env.APIFY_METADATA_REFRESH_ENABLED || "true").toLowerCase() === "true";
const apifyMetadataRefreshIntervalDaysEnv = Math.max(1, Math.min(30, Number(process.env.APIFY_METADATA_REFRESH_INTERVAL_DAYS || 7)));
const apifyMetadataRefreshBatchSizeEnv = Math.max(1, Math.min(15, Number(process.env.APIFY_METADATA_REFRESH_BATCH_SIZE || 3)));
const transcriptionProvider = (process.env.TRANSCRIPTION_PROVIDER || "openai").toLowerCase();
const localTranscriptionPython = process.env.LOCAL_TRANSCRIPTION_PYTHON || "python";
const localWhisperModel = process.env.LOCAL_WHISPER_MODEL || "small";
const localWhisperComputeType = process.env.LOCAL_WHISPER_COMPUTE_TYPE || "int8";
const localWhisperDevice = process.env.LOCAL_WHISPER_DEVICE || "auto";
const localWhisperLanguage = process.env.LOCAL_WHISPER_LANGUAGE || "";
const chatProvider = (process.env.CHAT_PROVIDER || "").toLowerCase();
const rateBucket = new Map();
const dashboardDecorCache = new Map();
const dashboardDecorInFlight = new Set();
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
        metadataRefreshEnabled: true,
        metadataRefreshIntervalDays: 7,
        metadataRefreshBatchSize: 3,
        lastMetadataRefreshAt: "",
        lastMetadataRefreshStatus: "",
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
        metadataRefreshEnabled: true,
        metadataRefreshIntervalDays: 7,
        metadataRefreshBatchSize: 3,
        lastMetadataRefreshAt: "",
        lastMetadataRefreshStatus: "",
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
    grounding: String(message?.grounding || ""),
    sourceReels: Array.isArray(message?.sourceReels)
      ? message.sourceReels.slice(0, 8).map((reel) => ({
          id: String(reel?.id || ""),
          title: String(reel?.title || "Untitled reel"),
          hook: String(reel?.hook || ""),
          pillar: String(reel?.pillar || ""),
          openingLine: String(reel?.openingLine || ""),
          postedAt: String(reel?.postedAt || ""),
          views: Number(reel?.views || 0)
        }))
      : [],
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

const HOOK_LABELS = [
  "Direct Hook", "Question Hook", "Curiosity Gap", "Negative Hook", "Positive Promise",
  "Story Opening", "Pattern Interrupt", "Social Proof", "Authority Hook", "Observation Hook",
  "Myth Busting", "Controversial Hook", "News / Announcement", "Data Hook", "Identity Hook",
  "Command Hook", "Emotional Hook", "Aspiration Hook", "Visual Hook", "Shock Hook",
  "Demonstration Hook", "Transformation Hook", "Contrarian Hook", "Speed Hook",
];

function canonicalizeHook(value, fallback = "Question Hook") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  const exact = HOOK_LABELS.find((label) => label.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  const normalized = text.toLowerCase();

  if (/(he.?s back|he’s back|returns as a titan|startup fest|ready to discover|announc|launch|launched|introducing|new update|excited to announce)/.test(normalized)) {
    return "News / Announcement";
  }
  if (/(^|\b)(question|rhetorical|why|what if|have you|are you|would you|ask)(\b|$)/.test(normalized)) return "Question Hook";
  if (/(curiosity|open loop|gap|withhold|wait until|nobody expected|changed everything)/.test(normalized)) return "Curiosity Gap";
  if (/(^|\b)(direct hook|direct|straight to value|no delay|let me show|here's how|explainer|framework|how to)(\b|$)/.test(normalized)) return "Direct Hook";
  if (/(negative|pain|mistake|loss|risk|wasting|danger|never buy)/.test(normalized)) return "Negative Hook";
  if (/(positive promise|promise|benefit|double|grow faster|learn this)/.test(normalized)) return "Positive Promise";
  if (/(story|narrative|three years ago|last night|yesterday this happened)/.test(normalized)) return "Story Opening";
  if (/(pattern interrupt|interrupt|stop scrolling|unexpected opening|throws|absurd statement)/.test(normalized)) return "Pattern Interrupt";
  if (/(social proof|testimonial|users|revenue|made .*\d|million people use|client made)/.test(normalized)) return "Social Proof";
  if (/(authority|expert|expertise|credential|as a doctor|working with|ten years)/.test(normalized)) return "Authority Hook";
  if (/(observation|everyone does this|we've all seen|rich people think differently|everyday truth)/.test(normalized)) return "Observation Hook";
  if (/(myth|busting|this advice is wrong|forget everything you've heard)/.test(normalized)) return "Myth Busting";
  if (/(controversial|polariz|college is a scam|hustle culture is fake|bold statement)/.test(normalized)) return "Controversial Hook";
  if (/(news|announcement|big update|launched|announced|timeliness)/.test(normalized)) return "News / Announcement";
  if (/(data hook|data|stat|statistics|research shows|numbers first|92%)/.test(normalized)) return "Data Hook";
  if (/(identity|if you're|every student should watch this|specific audience)/.test(normalized)) return "Identity Hook";
  if (/(command hook|command|listen carefully|save this|imperative)/.test(normalized)) return "Command Hook";
  if (/(emotional|emotion|fear|joy|shock|empathy|anger|excitement)/.test(normalized)) return "Emotional Hook";
  if (/(aspiration|future self|financially free|without an alarm)/.test(normalized)) return "Aspiration Hook";
  if (/(visual|before\/after transformation|dramatic reveal|extreme zoom|muted)/.test(normalized)) return "Visual Hook";
  if (/(shock hook|shock|surprising|disbelief|jarring|i lost)/.test(normalized)) return "Shock Hook";
  if (/(demonstration|demo|show don't tell|watch this|in action)/.test(normalized)) return "Demonstration Hook";
  if (/(transformation|before and after|before\/after|visible change|looked like this yesterday)/.test(normalized)) return "Transformation Hook";
  if (/(contrarian|unpopular|against common advice|you don't need)/.test(normalized)) return "Contrarian Hook";
  if (/(speed|quick|30 seconds|5 minutes|time compression|fast)/.test(normalized)) return "Speed Hook";

  return HOOK_LABELS.includes(fallback) ? fallback : "Question Hook";
}

const STRATEGY_LABELS = [
  "Education", "How-To", "Framework", "Storytelling", "Observation", "Authority Building",
  "Social Proof", "Case Study", "Breakdown", "Comparison", "Myth Busting", "Personal Brand",
  "Documentation", "Entertainment", "Inspiration", "Community Building", "Product Led", "Sales",
  "Trend Based", "News", "Reaction", "Challenge / Experiment", "Before & After", "Opinion / Hot Take", "Listicle",
];

function strategySourceText(reel) {
  const transcript = String(reel.transcript || "").replace(/\s+/g, " ").trim();
  const segments = Array.isArray(reel.timestampedTranscript)
    ? reel.timestampedTranscript.map((segment) => String(segment?.text || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5).join(" ")
    : "";
  const summary = Array.isArray(reel.scriptSummary)
    ? reel.scriptSummary.map((line) => String(line || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 3).join(" ")
    : "";
  const fallback = [reel.caption, reel.title].map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
  return (segments || transcript || summary || fallback).slice(0, 900);
}

function canonicalizeStrategy(value, fallback = "Education") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  const normalized = text.toLowerCase();
  const aliases = [
    ["How-To", /how[- ]?to|tutorial|step[- ]by[- ]step|actionable steps|process/],
    ["Framework", /framework|formula|blueprint|method|system|model|funnel/],
    ["Storytelling", /storytelling|narrative|beginning.*middle|conflict|resolution/],
    ["Observation", /observation|most people|we all|i.ve noticed|human behavior|market behavior/],
    ["Authority Building", /authority|expertise|years of experience|lessons learned|professional knowledge/],
    ["Social Proof", /social proof|revenue|followers|testimonial|clients|awards|case results/],
    ["Case Study", /case study|specific campaign|specific company|real numbers|walks through/],
    ["Breakdown", /breakdown|analy[sz]e|ad analysis|business analysis|website review|landing page review/],
    ["Comparison", /comparison| vs |better than|difference|pros and cons/],
    ["Myth Busting", /myth|misconception|wrong advice|popular myth/],
    ["Personal Brand", /personal philosophy|life lesson|my opinion|my thoughts|beliefs|values/],
    ["Documentation", /day in (the )?life|building in public|behind the scenes|office vlog|travel vlog/],
    ["Entertainment", /comedy|meme|funny|humou?r|skit/],
    ["Inspiration", /mindset|success|dreams|purpose|motivat|inspir/],
    ["Community Building", /poll|comment below|tell me|inside joke|audience participation/],
    ["Product Led", /product|use case|problem solved|tool|app|software/],
    ["Sales", /buy now|discount|offer|book a call|cta|lead magnet|sign up|available now/],
    ["Trend Based", /trending audio|viral format|challenge|trend|meme format/],
    ["News", /news|announcement|launch|launched|update|current event|breaking/],
    ["Reaction", /reaction|duet|reply|stitch|responding to|in response to|quote/],
    ["Challenge / Experiment", /i tried|we tested|let.s see|experiment|challenge|before results/],
    ["Before & After", /before and after|before \/ after|transformation|growth over time|improvement/],
    ["Opinion / Hot Take", /unpopular opinion|hot take|i believe|everyone disagrees|here.s why i think/],
    ["Listicle", /top \d+|\d+ mistakes|\d+ tools|\d+ lessons|first,|second,|third,/],
    ["Education", /explain|definition|what is|concept|learn|teaches|understand|means/],
  ];
  const match = aliases.find(([, pattern]) => pattern.test(normalized));
  return match ? match[0] : (STRATEGY_LABELS.includes(text) ? text : fallback);
}

function deriveStrategy(reel) {
  const existing = canonicalizeStrategy(reel.strategy || "", "");
  if (existing && STRATEGY_LABELS.includes(existing)) return existing;
  return canonicalizeStrategy(strategySourceText(reel), "Education");
}

function deriveHook(item) {
  const explicit = pickValue(item, ["hook", "hookType", "contentDetails.hook", "analysis.hook"], "");
  const explicitHook = canonicalizeHook(explicit, "");
  if (explicitHook && HOOK_LABELS.includes(explicitHook)) return explicitHook;

  const openingText = [
    pickValue(item, ["opening", "openingLine", "caption", "text", "description", "postText", "title"], ""),
    pickValue(item, ["transcript", "videoTranscript"], "")
  ].filter(Boolean).join(" ").slice(0, 900);
  return canonicalizeHook(openingText, "Question Hook");
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

function loadBusinessVideos() {
  try {
    const payload = JSON.parse(readFileSync(businessVideosPath, "utf8"));
    const videos = Array.isArray(payload.videos) ? payload.videos : [];
    return {
      ...payload,
      videos: videos.map((video) => ({
        id: String(video.id || video.postUrl || `business-${Math.random().toString(36).slice(2, 8)}`),
        title: String(video.title || "Untitled business reel"),
        caption: String(video.caption || ""),
        creator: String(video.creator || "Unknown creator"),
        username: String(video.username || ""),
        followers: Number(video.followers || 0),
        postUrl: String(video.postUrl || ""),
        thumbnailUrl: String(video.thumbnailUrl || ""),
        mediaUrl: String(video.mediaUrl || ""),
        plays: Number(video.plays || 0),
        likes: Number(video.likes || 0),
        comments: Number(video.comments || 0),
        engagementRate: Number(video.engagementRate || 0),
        duration: Number(video.duration || 0),
        publishedAt: String(video.publishedAt || ""),
        keyword: String(video.keyword || "business ideas"),
        mediaType: String(video.mediaType || "Reel"),
        hook: String(video.hook || "Business idea"),
        opportunity: String(video.opportunity || "business model"),
        hashtags: Array.isArray(video.hashtags) ? video.hashtags.map((tag) => String(tag || "")).filter(Boolean).slice(0, 8) : [],
        transcript: String(video.transcript || ""),
        timestampedTranscript: Array.isArray(video.timestampedTranscript)
          ? video.timestampedTranscript.map((segment, index) => ({
              index: Number(segment?.index || index + 1),
              time: String(segment?.time || ""),
              start: Number(segment?.start || 0),
              end: Number(segment?.end || 0),
              text: String(segment?.text || "")
            })).filter((segment) => segment.text)
          : [],
        transcriptSource: String(video.transcriptSource || ""),
        transcriptStatus: String(video.transcriptStatus || ""),
        transcriptUpdatedAt: String(video.transcriptUpdatedAt || ""),
        scriptSummary: Array.isArray(video.scriptSummary) ? video.scriptSummary.map((line) => String(line || "")).filter(Boolean).slice(0, 8) : []
      }))
    };
  } catch {
    return {
      source: "",
      exportedAt: "",
      keyword: "business ideas",
      summary: { totalVideos: 0, topPlays: 0, medianDuration: 0, topHashtags: [] },
      videos: []
    };
  }
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
  const pillar = normalizePillarLabel(reel.pillar, "General");
  const announcementText = [
    reel.title,
    reel.caption,
    transcript,
    scriptSummary.join(" ")
  ].filter(Boolean).join(" ").toLowerCase();
  const hook = /(he.?s back|he’s back|returns as a titan|startup fest|ready to discover|announc|launch|launched|introducing|new update|excited to announce)/.test(announcementText)
    ? "News / Announcement"
    : canonicalizeHook(reel.hook || "Question Hook");
  return {
    id: String(reel.id || `reel-${Math.random().toString(36).slice(2, 8)}`),
    title: String(reel.title || "Untitled reel"),
    platform: String(reel.platform || "instagram"),
    pillar,
    hook,
    strategy: deriveStrategy({ ...reel, transcript, timestampedTranscript, scriptSummary }),
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
    sourceName: String(reel.sourceName || ""),
    lastMetadataRefreshAt: String(reel.lastMetadataRefreshAt || "")
  };
}

function instagramPostKeyFromUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const shortcodeMatch = text.match(/\/(p|reel|tv)\/([^/?#]+)/i);
  if (shortcodeMatch) {
    return `${shortcodeMatch[1].toLowerCase()}:${shortcodeMatch[2].toLowerCase()}`;
  }
  try {
    const parsed = new URL(text);
    return `url:${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return `url:${text.toLowerCase()}`;
  }
}

function reelIdentityKeys(reel) {
  const keys = new Set();
  const id = String(reel?.id || "").trim();
  if (id) keys.add(`id:${id.toLowerCase()}`);

  const shortcode = String(
    pickValue(reel, ["shortCode", "shortcode", "short_code"], "")
  ).trim();
  if (shortcode) keys.add(`shortcode:${shortcode.toLowerCase()}`);

  [
    reel?.url,
    reel?.postUrl,
    reel?.inputUrl,
    reel?.permalink
  ].forEach((value) => {
    const key = instagramPostKeyFromUrl(value);
    if (key) keys.add(key);
  });

  return [...keys];
}

function mergeReelRecords(current, incoming) {
  const currentReel = normalizeReel(current);
  const incomingReel = normalizeReel(incoming);

  const keepExistingAnalysis = hasTranscriptPayload(currentReel);
  const incomingHasAnalysis = hasTranscriptPayload(incomingReel);
  const preserveExistingTaxonomy = keepExistingAnalysis && !incomingHasAnalysis;

  const merged = normalizeReel({
    ...currentReel,
    ...incomingReel,
    hook: preserveExistingTaxonomy ? currentReel.hook : incomingReel.hook,
    pillar: preserveExistingTaxonomy ? currentReel.pillar : incomingReel.pillar,
    strategy: preserveExistingTaxonomy ? currentReel.strategy : incomingReel.strategy,
    transcript: incomingHasAnalysis ? incomingReel.transcript : currentReel.transcript,
    timestampedTranscript: incomingHasAnalysis && incomingReel.timestampedTranscript.length
      ? incomingReel.timestampedTranscript
      : currentReel.timestampedTranscript,
    transcriptSource: incomingHasAnalysis ? incomingReel.transcriptSource : currentReel.transcriptSource,
    scriptSummary: incomingHasAnalysis && incomingReel.scriptSummary.length ? incomingReel.scriptSummary : currentReel.scriptSummary,
    sceneBreakdown: incomingHasAnalysis && incomingReel.sceneBreakdown.length ? incomingReel.sceneBreakdown : currentReel.sceneBreakdown,
    language: incomingReel.language || currentReel.language,
    audioType: incomingReel.audioType || currentReel.audioType,
    tone: incomingReel.tone || currentReel.tone,
    productionType: incomingReel.productionType || currentReel.productionType,
    cta: incomingReel.cta || currentReel.cta,
    analysisStatus: incomingHasAnalysis ? incomingReel.analysisStatus : keepExistingAnalysis ? currentReel.analysisStatus : incomingReel.analysisStatus,
    analysisError: incomingHasAnalysis ? incomingReel.analysisError : currentReel.analysisError,
    analysisUpdatedAt: incomingHasAnalysis ? incomingReel.analysisUpdatedAt : currentReel.analysisUpdatedAt,
    analysisProvider: incomingHasAnalysis ? incomingReel.analysisProvider : currentReel.analysisProvider,
    lastMetadataRefreshAt: incomingReel.lastMetadataRefreshAt || currentReel.lastMetadataRefreshAt
  });

  if (!preserveExistingTaxonomy) return merged;
  return {
    ...merged,
    hook: currentReel.hook,
    pillar: currentReel.pillar,
    strategy: currentReel.strategy
  };
}

function normalizePillarLabel(value, fallback = "General") {
  const label = String(value || "").trim();
  if (!label) return fallback;
  if (/^imported(\s+competitor)?$/i.test(label)) return fallback;
  return label;
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

const COMPETITOR_PROFILE_STATS = [
  {
    name: "Nikhil Kamath",
    handles: ["nikhilkamathcio"],
    followersExact: 1649382,
    followersDisplay: "1.65M",
    engagementRatePercent: 2.87,
    followerGrowth30dPercent: 0.93,
    snapshotDate: "2026-08-03",
    confidence: "high"
  },
  {
    name: "Ritesh Agarwal",
    handles: ["riteshagar"],
    followersExact: 1244667,
    followersDisplay: "1.24M",
    engagementRatePercent: 2.47,
    followerGrowth30dPercent: -0.73,
    snapshotDate: "2026-07-29",
    confidence: "high"
  },
  {
    name: "Deepinder Goyal",
    handles: ["deepigoyal"],
    followersExact: null,
    followersDisplay: "409K",
    engagementRatePercent: null,
    followerGrowth30dPercent: null,
    snapshotDate: "2026-08-05",
    confidence: "high"
  },
  {
    name: "Deepak Wadhwa",
    handles: ["deepakwadhwa.official", "deepakwadhwa"],
    followersExact: 1488822,
    followersDisplay: "1.49M",
    engagementRatePercent: 1.73,
    followerGrowth30dPercent: -0.77,
    snapshotDate: "2026-07-26",
    confidence: "high"
  },
  {
    name: "Deepak Bajwa",
    handles: [],
    followersExact: null,
    followersDisplay: null,
    engagementRatePercent: null,
    followerGrowth30dPercent: null,
    snapshotDate: null,
    confidence: "low",
    possibleDuplicateOf: "Deepak Wadhwa"
  },
  {
    name: "Kunal Shah",
    handles: ["kunalb11"],
    followersExact: null,
    followersDisplay: "244K",
    engagementRatePercent: 3.4,
    followerGrowth30dPercent: null,
    snapshotDate: "2026-08-05",
    confidence: "medium"
  },
  {
    name: "Varun Mayya",
    handles: ["thevarunmayya", "varunmayya"],
    followersExact: 1278366,
    followersDisplay: "1.28M",
    engagementRatePercent: 2.63,
    followerGrowth30dPercent: -0.11,
    snapshotDate: "2026-08-05",
    confidence: "high"
  },
  {
    name: "Ankur Warikoo",
    handles: ["ankurwarikoo"],
    followersExact: 4017443,
    followersDisplay: "4.02M",
    engagementRatePercent: 2.63,
    followerGrowth30dPercent: 0.95,
    snapshotDate: "2026-08-04",
    confidence: "high"
  },
  {
    name: "Ranveer Allahbadia",
    handles: ["beerbiceps", "ranveerallahbadia"],
    followersExact: 4202846,
    followersDisplay: "4.20M",
    engagementRatePercent: 5.48,
    followerGrowth30dPercent: -0.65,
    snapshotDate: "2026-08-03",
    confidence: "high"
  },
  {
    name: "Finance With Sharan",
    handles: ["financewithsharan"],
    followersExact: 2945458,
    followersDisplay: "2.95M",
    engagementRatePercent: 1.02,
    followerGrowth30dPercent: -0.49,
    snapshotDate: "2026-08-03",
    confidence: "high"
  },
  {
    name: "Raj Shamani",
    handles: ["rajshamani"],
    followersExact: 9671290,
    followersDisplay: "9.67M",
    engagementRatePercent: 2.96,
    followerGrowth30dPercent: 3.07,
    snapshotDate: "2026-08-05",
    confidence: "high"
  },
  {
    name: "Aman Gupta",
    handles: ["boatxaman"],
    followersExact: 1724940,
    followersDisplay: "1.72M",
    engagementRatePercent: 2.84,
    followerGrowth30dPercent: 0,
    snapshotDate: "2026-08-05",
    confidence: "high"
  }
];

function profileStatKey(value) {
  return String(value || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseCompactDisplayNumber(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return 0;
  const number = Number(text.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(number)) return 0;
  if (text.endsWith("M")) return Math.round(number * 1_000_000);
  if (text.endsWith("K")) return Math.round(number * 1_000);
  return Math.round(number);
}

function competitorProfileStatFor(profile, legacy) {
  const keys = new Set([
    profileStatKey(profile?.handle),
    profileStatKey(profile?.name),
    profileStatKey(legacy?.name),
    profileStatKey(legacy?.canonicalHandle)
  ]);
  (profile?.aliases || []).forEach((alias) => keys.add(profileStatKey(alias)));
  return COMPETITOR_PROFILE_STATS.find((stat) => {
    const statKeys = new Set([
      profileStatKey(stat.name),
      ...(stat.handles || []).map(profileStatKey)
    ]);
    return [...keys].some((key) => key && statKeys.has(key));
  }) || null;
}

function enrichCompetitorDisplayStats(row, profile, legacy) {
  const stat = competitorProfileStatFor(profile, legacy);
  if (!stat) return row;
  const followers = Number(row.followers || 0) || Number(stat.followersExact || 0) || parseCompactDisplayNumber(stat.followersDisplay);
  const engagementRate = Number(row.engagementRate || 0) || Number(stat.engagementRatePercent || 0);
  const monthlyGrowth = Number(row.monthlyGrowth || 0) || Number(stat.followerGrowth30dPercent || 0);
  const followersLabel = Number(row.followers || 0)
    ? row.followersLabel
    : (stat.followersDisplay || (followers ? fmtCompact(followers) : row.followersLabel));
  const engagementRateLabel = Number(row.engagementRate || 0)
    ? row.engagementRateLabel
    : (stat.engagementRatePercent === null || stat.engagementRatePercent === undefined ? row.engagementRateLabel : fmtPercent(stat.engagementRatePercent, 2));
  const monthlyGrowthLabel = Number(row.monthlyGrowth || 0)
    ? row.monthlyGrowthLabel
    : (stat.followerGrowth30dPercent === null || stat.followerGrowth30dPercent === undefined ? row.monthlyGrowthLabel : fmtSignedPercent(stat.followerGrowth30dPercent, 2));
  return {
    ...row,
    followers,
    engagementRate,
    monthlyGrowth,
    followersLabel,
    engagementRateLabel,
    monthlyGrowthLabel,
    profileStatsSnapshotDate: stat.snapshotDate || "",
    profileStatsConfidence: stat.confidence || "",
    possibleDuplicateOf: stat.possibleDuplicateOf || ""
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
  const rangeDays = clamp(Number(query.range || 365), 1, 365);
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
      buckets.set(key, { date: key, views: 0, saves: 0, engagements: 0, followers: 0, retention: 0, watchTime: 0, posts: 0 });
    }
    const bucket = buckets.get(key);
    bucket.views += reel.views;
    bucket.saves += reel.saves;
    bucket.engagements += Number(reel.likes || 0) + Number(reel.comments || 0) + Number(reel.shares || 0) + Number(reel.saves || 0);
    bucket.followers += reel.followersGained;
    bucket.retention += reel.retention;
    bucket.watchTime += reel.watchTime;
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
  const creatorOverride = CREATOR_FOLLOWER_OVERRIDES.get(topHandle) || CREATOR_FOLLOWER_OVERRIDES.get(String(store.creator?.handle || "").trim().toLowerCase()) || null;
  const inferredFollowers = reels
    .filter((reel) => String(reel.sourceHandle || "").trim().toLowerCase() === topHandle)
    .reduce((max, reel) => Math.max(max, Number(reel.sourceFollowers || 0)), 0);
  const followers = manualFollowers || Number(creatorOverride?.followers || 0) || inferredFollowers || 0;
  const derivedName = manualName || titleCase(topHandle || "Creator OS");
  const derivedNiche = manualNiche || [...new Set([...dominantPillars, ...topTopics])].slice(0, 3).join(", ") || "Creator analytics";
  return {
    name: derivedName,
    niche: derivedNiche,
    handle: String(store.creator?.handle || topHandle || "").trim().toLowerCase(),
    followers,
    followersLabel: followers ? (creatorOverride?.followersLabel || fmtCompact(followers)) : "0",
    followersSource: creatorOverride?.source || ""
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

function applyDashboardDecorations(dashboard, decorations) {
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

function primeDashboardDecorations(store, dashboard) {
  const cacheKey = dashboardDecorCacheKey(store, dashboard);
  if (dashboardDecorInFlight.has(cacheKey)) return;
  dashboardDecorInFlight.add(cacheKey);
  generateDashboardDecorations(store, dashboard)
    .catch(() => null)
    .finally(() => {
      dashboardDecorInFlight.delete(cacheKey);
    });
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
  const envResultsLimitSet = process.env.APIFY_AUTO_IMPORT_RESULTS_LIMIT !== undefined && process.env.APIFY_AUTO_IMPORT_RESULTS_LIMIT !== "";
  const envIntervalSet = process.env.APIFY_AUTO_IMPORT_INTERVAL_MINUTES !== undefined && process.env.APIFY_AUTO_IMPORT_INTERVAL_MINUTES !== "";
  const envMetadataIntervalSet = process.env.APIFY_METADATA_REFRESH_INTERVAL_DAYS !== undefined && process.env.APIFY_METADATA_REFRESH_INTERVAL_DAYS !== "";
  const envMetadataBatchSet = process.env.APIFY_METADATA_REFRESH_BATCH_SIZE !== undefined && process.env.APIFY_METADATA_REFRESH_BATCH_SIZE !== "";
  return {
    token: process.env.APIFY_TOKEN || config.token || "",
    mode: config.mode || "actor",
    actorId: process.env.APIFY_ACTOR_ID || config.actorId || "",
    profileActorId: process.env.APIFY_PROFILE_ACTOR_ID || config.profileActorId || "apify~instagram-profile-scraper",
    taskId: config.taskId || "",
    datasetId: config.datasetId || "",
    input: config.input || {},
    autoImportEnabled: apifyAutoImportEnabledEnv || config.autoImportEnabled === true,
    autoImportIntervalMinutes: Math.max(15, Number(envIntervalSet ? apifyAutoImportIntervalMinutesEnv : (config.autoImportIntervalMinutes || 60))),
    autoImportUsername: apifyAutoImportUsernameEnv || String(config.autoImportUsername || "").replace(/^@/, "").trim().toLowerCase(),
    autoImportResultsLimit: Math.max(1, Math.min(10, Number(envResultsLimitSet ? apifyAutoImportResultsLimitEnv : (config.autoImportResultsLimit || 3)))),
    metadataRefreshEnabled: apifyMetadataRefreshEnabledEnv || config.metadataRefreshEnabled === true,
    metadataRefreshIntervalDays: Math.max(1, Math.min(30, Number(envMetadataIntervalSet ? apifyMetadataRefreshIntervalDaysEnv : (config.metadataRefreshIntervalDays || 7)))),
    metadataRefreshBatchSize: Math.max(1, Math.min(15, Number(envMetadataBatchSet ? apifyMetadataRefreshBatchSizeEnv : (config.metadataRefreshBatchSize || 3)))),
    lastMetadataRefreshAt: String(config.lastMetadataRefreshAt || ""),
    lastMetadataRefreshStatus: String(config.lastMetadataRefreshStatus || ""),
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
  const savedQueries = Array.isArray(config.queries) ? config.queries.map((query) => String(query || "").trim()).filter(Boolean) : [];
  return {
    lastLiveRunAt: String(config.lastLiveRunAt || ""),
    lastSource: String(config.lastSource || ""),
    queries: savedQueries.length >= 10 ? savedQueries : [],
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
    .replaceAll("&nbsp;", " ")
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
  const competitorNames = (store.competitorProfiles || [])
    .map((profile) => String(profile?.name || "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const competitorAngles = (store.competitorProfiles || [])
    .map((profile) => {
      const angle = String(profile?.angle || "").trim();
      if (!angle || /^(imported competitor|unknown|general)$/i.test(angle)) return "";
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
    ...competitorNames.map((name) => `${name} creator business India`),
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
    "business creators India",
    "Bharat creators brand strategy",
    "regional creators India brands",
    "quick commerce D2C brands India",
    "ONDC D2C brands India",
    "startup funding India consumer brands",
    "VC funding India D2C brands",
    "Indian creator monetisation platforms",
    "influencer marketing spends India",
    "YouTube India creator economy",
    "Instagram India creator monetisation",
    "site:inc42.com creator economy India",
    "site:inc42.com D2C India",
    "site:yourstory.com creator economy India",
    "site:yourstory.com D2C India",
    "site:entrackr.com creator economy India",
    "site:entrackr.com D2C India",
    "site:medianama.com creator economy India",
    "site:afaqs.com influencer marketing India",
    "site:socialsamosa.com creator economy India",
    "site:campaignindia.in influencer marketing India",
    "site:exchange4media.com creator economy India",
    "site:storyboard18.com creator economy India",
    "site:adgully.com creator economy India",
    "site:brandequity.economictimes.indiatimes.com creator economy India"
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

function safeCacheId(value) {
  return String(value || "")
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 80) || "thumb";
}

function thumbnailCachePath(id) {
  return path.join(thumbnailCacheDir, `${safeCacheId(id)}.img`);
}

function thumbnailInitials(reel) {
  return String(reel?.sourceHandle || reel?.title || reel?.caption || "Reel")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "RE";
}

function thumbnailFallbackSvg(reel) {
  const initials = thumbnailInitials(reel);
  const title = stripHtml(reel?.title || reel?.caption || "Reel thumbnail unavailable").slice(0, 64);
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#f4dfaa"/>
          <stop offset="1" stop-color="#8f6a18"/>
        </linearGradient>
        <radialGradient id="glow" cx="25%" cy="15%" r="80%">
          <stop stop-color="#ffffff" stop-opacity=".55"/>
          <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="160" height="160" rx="30" fill="url(#bg)"/>
      <rect width="160" height="160" rx="30" fill="url(#glow)"/>
      <circle cx="80" cy="66" r="34" fill="rgba(255,255,255,.35)"/>
      <text x="80" y="78" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="800" fill="#2b2114">${escapeXml(initials)}</text>
      <text x="80" y="122" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="#3b2c16">${escapeXml(title)}</text>
    </svg>
  `.trim());
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&#x26;", "&")
    .replaceAll("&#38;", "&");
}

function extractInstagramPageThumbnail(html) {
  const source = String(html || "");
  const patterns = [
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
    /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i,
    /<meta[^>]+property="og:image:secure_url"[^>]+content="([^"]+)"/i,
    /<meta[^>]+content="([^"]+)"[^>]+property="og:image:secure_url"/i,
    /"display_url":"([^"]+)"/i,
    /"thumbnail_src":"([^"]+)"/i,
    /"display_resources":\[\{"src":"([^"]+)"/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match?.[1]) continue;
    return decodeHtmlEntities(String(match[1]).replaceAll("\\u0026", "&").replaceAll("\\/", "/"));
  }
  return "";
}

async function fetchInstagramPageThumbnailUrl(postUrl) {
  if (!postUrl || !/^https:\/\/www\.instagram\.com\/p\//i.test(postUrl)) return "";
  try {
    const pageResponse = await fetch(postUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.instagram.com/"
      }
    });
    if (!pageResponse.ok) return "";
    return extractInstagramPageThumbnail(await pageResponse.text());
  } catch {
    return "";
  }
}

async function fetchRemoteThumbnailBuffer(thumbnailUrl) {
  if (!thumbnailUrl || !/^https:\/\/(?:[^/]+\.)*(?:instagram\.com|cdninstagram\.com|fbcdn\.net)\//i.test(thumbnailUrl)) {
    return null;
  }
  try {
    const imageResponse = await fetch(thumbnailUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.instagram.com/",
        Origin: "https://www.instagram.com"
      }
    });
    if (!imageResponse.ok) return null;
    return {
      buffer: Buffer.from(await imageResponse.arrayBuffer()),
      contentType: imageResponse.headers.get("content-type") || "image/jpeg"
    };
  } catch {
    return null;
  }
}

async function prewarmThumbnailCache(reels = [], limit = 4) {
  const queue = (Array.isArray(reels) ? reels : [])
    .map(normalizeReel)
    .filter((reel) => reel.id && reel.thumbnailUrl)
    .sort((left, right) => new Date(right.postedAt || 0) - new Date(left.postedAt || 0))
    .slice(0, limit);

  if (!queue.length) return;
  await mkdir(thumbnailCacheDir, { recursive: true }).catch(() => {});
  for (const reel of queue) {
    const cachePath = thumbnailCachePath(reel.id);
    const cached = await readFile(cachePath).catch(() => null);
    if (cached) continue;
    const fetched = await fetchRemoteThumbnailBuffer(reel.thumbnailUrl);
    if (!fetched?.buffer?.length) continue;
    await writeFile(cachePath, fetched.buffer).catch(() => {});
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
    const headlineKey = slugify(normalized.headline).slice(0, 110);
    const sourceKey = slugify(normalized.source).slice(0, 40);
    const key = headlineKey ? `${headlineKey}:${sourceKey}` : normalized.url || normalized.id;
    byId.set(String(key), normalized);
  });
  return [...byId.values()]
    .sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt))
    .slice(0, 160);
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
  const expandedQueries = buildLiveNewsQueries(store);
  const queries = Array.isArray(options.queries) && options.queries.length
    ? options.queries.map((query) => String(query || "").trim()).filter(Boolean)
    : [...config.queries, ...expandedQueries].filter((query, index, list) => {
        const normalized = String(query || "").trim().toLowerCase();
        return normalized && list.findIndex((item) => String(item || "").trim().toLowerCase() === normalized) === index;
      }).slice(0, newsQueryLimit);
  if (!queries.length) throw new Error("No live news queries available.");

  const perQuery = clamp(Number(options.perQuery || 12), 1, 25);
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
    .slice(0, 120);

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
          const topHook = canonicalizeHook(legacy?.topHookSeed || legacy?.warning || "Question Hook");
          return enrichCompetitorDisplayStats({
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
          }, profile, legacy);
        })
      : (store.competitors || []).map(normalizeCompetitor).map((competitor) => ({
          ...competitor,
          postsPerWeek: Number(competitor.postsPerWeekSeed || 0),
          postsPerWeekLabel: Number(competitor.postsPerWeekSeed || 0) ? round(Number(competitor.postsPerWeekSeed || 0), 1).toFixed(1) : "0.0",
          avgViews: Number(competitor.avgViewsSeed || 0),
          avgViewsLabel: fmtCompact(Number(competitor.avgViewsSeed || 0)),
          topHook: canonicalizeHook(competitor.topHookSeed || competitor.warning || "Question Hook"),
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
      const topHook = reels.length
        ? bestLabelByViews(reels, "hook", canonicalizeHook(legacy?.topHookSeed || legacy?.warning || "Question Hook"))
        : canonicalizeHook(legacy?.topHookSeed || legacy?.warning || "Question Hook");
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
      return enrichCompetitorDisplayStats({
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
      }, profile, legacy);
    })
    .sort((left, right) => right.monthlyGrowth - left.monthlyGrowth);
}

function computeDashboard(store, query) {
  const businessVideos = loadBusinessVideos();
  const reels = store.reels.map(normalizeReel);
  const creatorHandle = inferPrimaryCreatorHandle(store);
  const creatorReels = creatorHandle
    ? reels.filter((reel) => String(reel.sourceHandle || "").trim().toLowerCase() === creatorHandle)
    : reels;
  const filtered = applyFilters(creatorReels, query);
  const range = clamp(Number(query.range || 365), 1, 365);
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

  const configuredLookbackDays = Math.min(14, Math.max(1, Number(newsConfig(store).lookbackDays || newsLookbackDays)));
  const recentNews = store.news
    .map(normalizeNews)
    .filter((story) => isRecentNewsStory(story, configuredLookbackDays));
  const storedNewsFallback = recentNews.length
    ? []
    : store.news
        .map(normalizeNews)
        .sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt))
        .slice(0, 80)
        .map((story) => ({ ...story, isArchived: true }));
  const newsInput = recentNews.length ? recentNews : storedNewsFallback;
  const news = newsInput
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
        status: recentNews.length
          ? (news.some((story) => story.sourceType === "live-rss" || story.sourceType === "apify") ? "live-imported" : "seeded")
          : "archive",
        label: recentNews.length
          ? `News imported live (${configuredLookbackDays}d)`
          : `Archive news shown · refresh for live (${configuredLookbackDays}d)`,
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
    businessVideos,
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
  const cacheKey = dashboardDecorCacheKey(store, dashboard);
  const cached = dashboardDecorCache.get(cacheKey);
  if (!cached) {
    primeDashboardDecorations(store, dashboard);
    return dashboard;
  }
  if (Date.now() - cached.updatedAt >= 10 * 60_000) {
    primeDashboardDecorations(store, dashboard);
  }
  return applyDashboardDecorations(dashboard, cached.payload);
}

function compactDashboard(dashboard) {
  const compactReel = (reel) => {
    const fields = [
      "id", "title", "url", "thumbnailUrl", "platform", "pillar", "hook", "strategy", "format", "postedAt",
      "views", "likes", "comments", "shares", "saves", "retention", "watchTime",
      "followersGained", "sourceHandle", "sourceName", "viewsLabel", "likesLabel",
      "commentsLabel", "savesLabel", "engagementRateLabel", "retentionLabel", "watchTimeLabel",
      "postedAtLabel"
    ];
    return Object.fromEntries(fields.filter((field) => field in reel).map((field) => [field, reel[field]]));
  };
  return {
    ...dashboard,
    posts: (dashboard.posts || []).map(compactReel),
    topReels: (dashboard.topReels || []).map(compactReel),
    competitors: (dashboard.competitors || []).map((competitor) => ({
      ...competitor,
      reels: (competitor.reels || []).map(compactReel),
    })),
    // Competitor rows already contain the summaries needed for the page. Full reel data is lazy-loaded on click.
    competitorReels: [],
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

function transcriptSnippetScore(snippet, queryTokens) {
  const haystack = String(snippet || "").toLowerCase();
  return queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function bestTranscriptSnippet(reel, queryTokens) {
  const segmentTexts = normalizeTimestampedTranscript(reel.timestampedTranscript)
    .map((segment) => segment.text)
    .filter(Boolean);
  const sceneTexts = Array.isArray(reel.sceneBreakdown)
    ? reel.sceneBreakdown.map((scene) => scene?.text).filter(Boolean)
    : [];
  const candidates = [
    ...segmentTexts.slice(0, 12),
    ...sceneTexts.slice(0, 8),
    ...String(reel.transcript || "").split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 12)
  ]
    .map((text) => compactChatText(text, 220))
    .filter(Boolean);
  if (!candidates.length) return "";
  if (!queryTokens.length) return candidates[0];
  return candidates
    .map((text, index) => ({ text, score: transcriptSnippetScore(text, queryTokens), index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]
    .text;
}

function transcriptStrength(reel) {
  const segments = normalizeTimestampedTranscript(reel.timestampedTranscript);
  if (segments.length >= 3) return 3;
  if (String(reel.transcript || "").trim()) return 2;
  if (Array.isArray(reel.scriptSummary) && reel.scriptSummary.length) return 1;
  return 0;
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
  const competitorMatch = matchedCompetitorFromPrompt(prompt, dashboard);
  const competitorHandle = String(competitorMatch?.canonicalHandle || competitorMatch?.handle || "").replace(/^@/, "").trim().toLowerCase();
  const currentRangeDays = clamp(Number(dashboard.filters?.range || 365), 1, 365);
  const rangeStart = daysAgo(currentRangeDays - 1);
  const rangeEnd = now();
  const creatorReels = Array.isArray(dashboard.posts) ? dashboard.posts : [];
  const competitorReels = (Array.isArray(dashboard.competitorReels) ? dashboard.competitorReels : [])
    .filter((reel) => {
      const postedAt = new Date(reel.postedAt);
      return !Number.isNaN(postedAt.getTime()) && postedAt >= rangeStart && postedAt <= rangeEnd;
    });

  return [...creatorReels, ...competitorReels]
    .map(normalizeReel)
    .map((reel) => {
      const transcript = reelTranscriptText(reel);
      if (!transcript) return null;
      const openingLine = compactChatText(
        normalizeTimestampedTranscript(reel.timestampedTranscript)[0]?.text
          || reel.scriptSummary?.[0]
          || transcript,
        140
      );
      const matchedSnippet = bestTranscriptSnippet(reel, queryTokens);
      const haystack = [
        reel.title,
        reel.caption,
        reel.hook,
        reel.pillar,
        reel.strategy,
        transcript
      ].join(" ").toLowerCase();
      const keywordScore = queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
      const score = keywordScore * 10
        + (topIds.has(String(reel.id)) ? 8 : 0)
        + (competitorHandle && String(reel.sourceHandle || "").replace(/^@/, "").trim().toLowerCase() === competitorHandle ? 16 : 0)
        + transcriptSnippetScore(openingLine, queryTokens) * 6
        + transcriptSnippetScore(matchedSnippet, queryTokens) * 8
        + transcriptStrength(reel) * 5
        + Math.min(8, Number(reel.views || 0) / 100000);
      return {
        id: reel.id,
        title: compactChatText(reel.title || reel.caption || "Untitled reel", 90),
        postedAt: reel.postedAt,
        hook: reel.hook,
        pillar: reel.pillar,
        strategy: reel.strategy,
        sourceHandle: reel.sourceHandle,
        sourceName: reel.sourceName,
        views: reel.views,
        engagementRate: reel.engagementRate,
        openingLine,
        matchedSnippet: matchedSnippet || openingLine,
        transcript: compactChatText(transcript, 320),
        transcriptStrength: transcriptStrength(reel),
        rangeDays: currentRangeDays,
        score
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map(({ score, ...item }) => item);
}

function transcriptSourceReels(transcriptContext = [], limit = 6) {
  return (Array.isArray(transcriptContext) ? transcriptContext : [])
    .slice(0, limit)
    .map((reel) => ({
      id: reel.id,
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      openingLine: reel.openingLine,
      postedAt: reel.postedAt,
      views: reel.views
    }));
}

function isGenericTranscriptPillar(value) {
  const pillar = String(value || "").trim().toLowerCase();
  return !pillar || pillar === "general" || pillar === "imported";
}

function transcriptItemsCompatible(primary, candidate) {
  if (!primary || !candidate) return false;
  if (String(primary.id || "") === String(candidate.id || "")) return false;
  const primaryHook = String(primary.hook || "").trim().toLowerCase();
  const candidateHook = String(candidate.hook || "").trim().toLowerCase();
  const primaryPillar = String(primary.pillar || "").trim().toLowerCase();
  const candidatePillar = String(candidate.pillar || "").trim().toLowerCase();
  const primaryStrategy = String(primary.strategy || "").trim().toLowerCase();
  const candidateStrategy = String(candidate.strategy || "").trim().toLowerCase();
  return Boolean(
    (primaryHook && candidateHook && primaryHook === candidateHook)
    || (
      primaryPillar
      && candidatePillar
      && !isGenericTranscriptPillar(primaryPillar)
      && !isGenericTranscriptPillar(candidatePillar)
      && primaryPillar === candidatePillar
    )
    || (primaryStrategy && candidateStrategy && primaryStrategy === candidateStrategy)
  );
}

function selectTranscriptPattern(transcriptContext = []) {
  const items = Array.isArray(transcriptContext) ? transcriptContext.filter(Boolean) : [];
  const lead = items[0] || null;
  const support = lead
    ? items.find((item) => transcriptItemsCompatible(lead, item)) || null
    : null;
  return { lead, support };
}

function transcriptPatternPillar(lead, context) {
  const leadPillar = String(lead?.pillar || "").trim();
  if (leadPillar && !isGenericTranscriptPillar(leadPillar)) return leadPillar;
  return "one specific lane";
}

function chatGroundingMeta(transcriptContext = [], options = {}) {
  if (options.analyticsOnly) {
    return { grounding: "analytics", sourceReels: [] };
  }
  const sourceReels = transcriptSourceReels(transcriptContext, Number(options.limit || 6));
  return {
    grounding: sourceReels.length ? "transcript" : "analytics",
    sourceReels
  };
}

function confidenceBand(sampleSize = 0) {
  const count = Math.max(0, Number(sampleSize || 0));
  if (count >= 50) return { label: "High", reason: `${count} matching examples` };
  if (count >= 15) return { label: "Medium", reason: `${count} matching examples` };
  if (count >= 5) return { label: "Low", reason: `${count} matching examples` };
  return { label: "Very low", reason: count ? `${count} matching examples` : "insufficient matching examples" };
}

function transcriptConfidenceLine(transcriptContext = []) {
  const confidence = confidenceBand(Array.isArray(transcriptContext) ? transcriptContext.length : 0);
  return `Confidence: ${confidence.label} confidence. Reason: ${confidence.reason}.`;
}

function isMonthlySummaryRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  return query.includes("monthly summary")
    || (query.includes("month") && query.includes("summary"))
    || (query.includes("current dashboard") && query.includes("summary"));
}

function isWeeklyPlanRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  return query.includes("weekly plan")
    || query.includes("week plan")
    || query.includes("plan for this week")
    || query.includes("7 day plan")
    || query.includes("7-day plan");
}

function isNewsScriptRequest(prompt, selectedStory = null) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  const mentionsScript = query.includes("script") || query.includes("ready-to-record") || query.includes("ready to record");
  const mentionsStory = query.includes("selected story")
    || query.includes("this story")
    || query.includes("news story")
    || query.includes("top news")
    || query.includes("headline")
    || query.includes("turn this")
    || (selectedStory?.headline && query.includes(String(selectedStory.headline).toLowerCase().slice(0, 24)));
  const mentionsReel = query.includes("reel") || query.includes("brief") || query.includes("angle");
  return Boolean(selectedStory?.headline) && mentionsStory && (mentionsScript || mentionsReel);
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

function isNextPostRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  if (/\b(script|write|ready-to-record|ready to record|full script|make it into a reel)\b/.test(query)) {
    return false;
  }
  return (query.includes("next post") || query.includes("what should i post next") || query.includes("post next"))
    || (query.includes("next reel") && !query.includes("news"))
    || query.includes("next-post planner")
    || query.includes("build my next post")
    || query.includes("plan my next post");
}

function isContentIdeasRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  return /\b(ideas?|content ideas?|post ideas?|reel ideas?)\b/.test(query)
    && (/\b(20|twenty|10|ten|list|give|generate|based on|current hooks|pillars|transcripts?)\b/.test(query));
}

function isAllReelsAnalysisRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  return /^(analyse|analyze)\s+all\s+my\s+reels$/.test(query)
    || /^(analyse|analyze)\s+my\s+reels$/.test(query)
    || (query.includes("all my reels") && (query.includes("analyse") || query.includes("analyze") || query.includes("breakdown")));
}

function isAllScriptsAnalysisRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  return (/\b(analyse|analyze|audit|breakdown|review)\b/.test(query)
    && /\b(all\s+)?(scripts?|transcripts?|content scripts?)\b/.test(query));
}

function isOutshineStrategyRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  return /\b(outshine|stand out|beat competitors?|improve my content|what i have to do|what should i do|see my content)\b/.test(query)
    && /\b(content|reels?|competitors?|creator|strategy|outshine)\b/.test(query);
}

function isBestReelAnalysisRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase().replace(/[\\]+$/g, "");
  if (!query) return false;
  return (
    (query.includes("best reel") || query.includes("bestest reel") || query.includes("top reel") || query.includes("best performing reel"))
    && (query.includes("analyse") || query.includes("analyze") || query.includes("breakdown") || query.includes("audit"))
  ) || /^(analyse|analyze)\s+my\s+best(est)?\s+reel$/.test(query);
}

function matchedCompetitorFromPrompt(prompt, dashboard) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return null;
  return (dashboard.competitors || []).find((competitor) => {
    const name = String(competitor.name || "").trim().toLowerCase();
    const handle = String(competitor.canonicalHandle || competitor.handle || "").replace(/^@/, "").trim().toLowerCase();
    return (name && query.includes(name)) || (handle && query.includes(handle));
  }) || null;
}

function isCompetitorMomentumRequest(prompt, dashboard) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  const mentionsBreakdown = /\b(break down|breakdown|momentum|recent content|recent reels|content momentum|analy[sz]e)\b/.test(query);
  return mentionsBreakdown && Boolean(matchedCompetitorFromPrompt(prompt, dashboard));
}

function isTranscriptStrategyRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  if (isMonthlySummaryRequest(query) || isWeeklyPlanRequest(query)) return false;
  if (/\b(summary|summarize|dashboard|analytics|kpi|report)\b/.test(query) && !/\b(transcript|transcription|script|reel|hook|ideas?|audit|rewrite)\b/.test(query)) {
    return false;
  }
  const transcriptIntent = [
    "transcript", "transcription", "script", "reel", "hook", "idea", "ideas", "analysis", "analyze",
    "audit", "breakdown", "rewrite", "angle", "angles", "caption", "structure", "pacing", "opening",
    "opener", "viral", "improve", "better", "next", "detail", "detailed", "deep"
  ].some((token) => query.includes(token));
  const askIntent = [
    "idea", "ideas", "analysis", "analyze", "audit", "breakdown", "rewrite", "angle", "script",
    "hook", "hooks", "next", "improve", "better", "detail", "detailed", "deep", "kyu", "why", "kaise", "kya"
  ].some((token) => query.includes(token));
  return transcriptIntent && askIntent;
}

function shouldForceTranscriptRead(prompt, dashboard) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  if (!Array.isArray(dashboard?.transcriptContext) || !dashboard.transcriptContext.length) return false;
  if (
    isMonthlySummaryRequest(query)
    || isWeeklyPlanRequest(query)
    || isNewsScriptRequest(query, null)
    || isAllReelsAnalysisRequest(query)
    || isAllScriptsAnalysisRequest(query)
    || isOutshineStrategyRequest(query)
    || isBestReelAnalysisRequest(query)
  ) return false;
  if (/\b(transcript|transcribed|transcription|script summary|timestamped|scene-by-scene|scene by scene|caption lines)\b/.test(query)) {
    return true;
  }
  if ((/\b(analyse|analyze|analysis|audit|breakdown|deep dive|detail|detailed)\b/.test(query))
    && /\b(reel|reels|content)\b/.test(query)) {
    return true;
  }
  if (matchedCompetitorFromPrompt(prompt, dashboard)
    && /\b(analyse|analyze|analysis|audit|breakdown|transcript|script|hook)\b/.test(query)
    && !/\b(momentum|growth|followers|positioning|radar)\b/.test(query)) {
    return true;
  }
  return false;
}

function isFullScriptRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  return /\b(full script|write script|write a script|reel script|ready-to-record|make it into a reel|refine it|script bna|script bana|record)\b/.test(query)
    || (query.includes("script") && /\b(good|better|refine|reel|works for me|past data|according)\b/.test(query));
}

function chatMonthlySummaryAnswer(dashboard) {
  const context = buildContextSummary(dashboard);
  const kpis = Array.isArray(dashboard.kpis) ? dashboard.kpis.slice(0, 6) : [];
  const topReel = dashboard.topReels?.[0];
  const topHook = context.hookLeader?.label || "top hook";
  const topPillar = context.pillarLeader?.label || "top pillar";
  const competitor = context.topCompetitor;
  const news = context.topNews;
  return [
    "Monthly dashboard summary",
    `Performance: ${kpis.map((kpi) => `${kpi.label} ${kpi.value}`).join(", ") || context.kpis}.`,
    topReel ? `Top content signal: "${compactChatText(topReel.title || topReel.caption, 120)}" led the set with ${topReel.viewsLabel || fmtCompact(topReel.views)} views. The repeatable pattern is ${topHook} inside ${topPillar}.` : `Top content signal: ${topHook} inside ${topPillar}.`,
    competitor ? `Competitor signal: ${competitor.name} is the key watchlist creator right now with ${competitor.monthlyGrowthLabel || "tracked"} momentum and ${competitor.bestFormat || "short video"} as the visible format.` : "",
    news ? `News signal: "${compactChatText(news.headline, 120)}" is the strongest live angle to convert into a topical reel.` : "",
    "What to do next: publish 2 data-hook explainers, 1 founder/story reel, 1 topical news response, and 1 re-cut of the best opener pattern. Do not spread into new pillars until the current winners are exhausted.",
    "Confidence: Medium confidence. Reason: this uses current dashboard winners, but not a single narrow content slice."
  ].filter(Boolean).join("\n\n");
}

function chatWeeklyPlanAnswer(dashboard, transcriptContext = []) {
  const context = buildContextSummary(dashboard);
  const lead = transcriptContext?.[0] || null;
  const topHook = lead?.hook || context.hookLeader?.label || "Data Hook";
  const topPillar = lead?.pillar || context.pillarLeader?.label || "Business";
  const opener = lead?.openingLine || "Start with one specific number or contradiction.";
  return [
    "Weekly content plan",
    `Rule for the week: stay inside ${topPillar}, use ${topHook}, and open close to this proven rhythm: "${compactChatText(opener, 140)}"`,
    "Mon: Data-led business breakdown. Open with one surprising number, then explain the hidden mechanism.",
    "Tue: Founder lesson reel. Use one personal mistake or decision, then extract the business principle.",
    "Wed: Competitor/news response. Take the strongest News Radar story and turn it into a direct-to-camera opinion.",
    "Thu: Re-cut winner. Reuse the best opening structure from the source transcript, but swap the example.",
    "Fri/Sat: High-conviction prediction. One strong claim, one proof point, one takeaway.",
    "Measurement: judge the week by hook retention, saves/comments, and whether the first 3 seconds can stand alone as a headline.",
    transcriptConfidenceLine(transcriptContext)
  ].join("\n\n");
}

function selectedHookIndex(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  const match = query.match(/option\s*([123])/) || query.match(/^([123])$/);
  if (!match) return null;
  return Number(match[1]) - 1;
}

function transcriptStrategyFallbackAnswer(prompt, dashboard, transcriptContext = []) {
  const context = buildContextSummary(dashboard);
  const { lead } = selectTranscriptPattern(transcriptContext);
  if (!lead) {
    return [
      "Transcript-backed analysis is not available yet.",
      "Import or analyze a few reels with transcripts first, then ask for ideas, hooks, script rewrites, or a reel audit."
    ].join("\n\n");
  }
  const pillar = transcriptPatternPillar(lead, context);
  const hook = lead.hook || dashboard.charts?.hooks?.[0]?.label || "direct hook";
  const opener = lead.openingLine || lead.matchedSnippet || lead.transcript || "Start with the strongest claim first.";
  const supportLine = lead.matchedSnippet && lead.matchedSnippet !== opener ? lead.matchedSnippet : "";
  return [
    "Transcript-backed analysis",
    `Closest reference: "${lead.title}" is the strongest transcript match right now. It opens with "${compactChatText(opener, 170)}" and sits inside ${pillar} with a ${hook} packaging style.`,
    `Why this pattern works: the reel gets to the point fast, removes confusion early, and sounds creator-native rather than over-explained. The opener creates immediate curiosity, then the body translates that curiosity into one concrete business or creator takeaway instead of five loose ideas.`,
    supportLine ? `Best supporting line to borrow: "${compactChatText(supportLine, 170)}". This is useful because it shows the pace and sentence shape that already works in your own catalogue.` : "",
    "What to copy: keep the first line highly specific, keep the second beat as the hidden mechanism, and keep the close opinionated. Do not turn the middle of the reel into general education.",
    "What to avoid: do not stack multiple examples, do not switch lane mid-reel, and do not explain the point before the viewer feels the tension.",
    "Idea directions: 1. A contrarian founder/business claim with one proof point. 2. A myth-vs-reality format inside the same topic lane. 3. A hidden-growth-mechanism breakdown using the same opener rhythm. 4. A competitor pattern teardown in your voice. 5. A re-cut of an old winner with a sharper first sentence.",
    transcriptConfidenceLine(transcriptContext),
    "Next action: ask for `write full script from this transcript pattern` or `audit this transcript line by line` and I will turn this into a much more concrete output."
  ].filter(Boolean).join("\n\n");
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
    ? `Pattern learned from "${referenceReel.title}": opener "${referenceReel.openingLine || referenceReel.transcript}" and phrasing "${compactChatText(referenceReel.matchedSnippet || referenceReel.transcript, 190)}"`
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
    "Delivery: 35-45 sec, direct-to-camera, one bold text overlay in the first frame, tight cuts every 2-3 sec.",
    transcriptConfidenceLine(transcriptContext),
    "Next action: record this as a single-opinion reel, not a news summary."
  ].filter(Boolean).join("\n\n");
}

function chatNextPostAnswer(dashboard, transcriptContext = []) {
  const context = buildContextSummary(dashboard);
  const { lead } = selectTranscriptPattern(transcriptContext);
  const hook = lead?.hook || context.hookLeader?.label || "Question Hook";
  const pillar = transcriptPatternPillar(lead, context);
  const opener = lead?.openingLine || "Most people are missing the real reason this is happening.";
  const topic = reelTopicFromLead(lead, context.topReel?.title || "this founder story");
  const scriptLines = buildWordForWordScript({
    lead,
    hook,
    pillar,
    topicHint: topic,
    openerStyle: opener,
    referenceLine: lead?.matchedSnippet || ""
  });
  return [
    "Next post package",
    `Angle: Build the next post around ${topic}. Use a ${hook} opener and keep it inside ${pillar}.`,
    "",
    "Opening hook options",
    `1. ${opener}`,
    `2. Most people will miss the real business lesson inside ${compactChatText(topic, 80)}.`,
    `3. This looks like a simple story, but it shows exactly how niche markets are built.`,
    "",
    "Final reel script",
    `Hook (0-3s): ${scriptLines[0]}`,
    `Beat 1 (3-10s): ${scriptLines[1]}`,
    `Beat 2 (10-22s): ${scriptLines[2]}`,
    `Beat 3 (22-35s): ${scriptLines[3]}`,
    `Close (35-45s): ${scriptLines[4]}`,
    "",
    "Caption",
    `The best founder stories are not just inspiring. They show you where a niche is quietly getting built. ${compactChatText(topic, 120)} is one of those examples.`,
    "",
    "CTA",
    "Save this if you want more business breakdowns built from real creator patterns.",
    "",
    "Why this should work",
    `It copies your saved transcript rhythm: a specific first line, one clear founder/business insight, and a practical close. It avoids switching into a second unrelated story mid-reel.`,
    `Best posting window: ${dashboard.insights?.[3]?.title || "your highest-scoring time slot"}.`,
    transcriptConfidenceLine(transcriptContext)
  ].join("\n\n");
}

function extractDraftForScript(prompt) {
  const text = compactChatText(prompt, 2600);
  const markers = [
    "im thinking to reel this",
    "make it into a reel script",
    "refine it",
    "write full script",
    "script bnao",
    "script bana"
  ];
  let draft = text;
  for (const marker of markers) {
    const index = draft.toLowerCase().indexOf(marker);
    if (index > 80) draft = draft.slice(0, index).trim();
  }
  return draft || text;
}

function normalizeChatHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((entry) => ({
      role: entry?.role === "assistant" ? "assistant" : "user",
      text: String(entry?.text || "").slice(0, 4000).trim()
    }))
    .filter((entry) => entry.text);
}

function previousHistoryMessage(history = [], role = "user", currentPrompt = "") {
  const cleanPrompt = compactChatText(currentPrompt || "", 4000);
  const items = normalizeChatHistory(history);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.role !== role) continue;
    if (item.text === cleanPrompt) continue;
    return item.text;
  }
  return "";
}

function extractHookFromAssistantHistory(text = "") {
  const source = String(text || "");
  const patterns = [
    /Ready Hook\s*[\r\n]+["“]?([^"\n\r]+)["”]?/i,
    /Ready Hook\s*[:\-]?\s*["“]?([^"\n\r]+)["”]?/i,
    /Hook(?:\s*\(0-3s\))?:\s*([^\n\r]+)/i,
    /Audio:\s*"([^"]+)"/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return compactChatText(match[1], 180);
  }
  return "";
}

function scriptSourceFromContext(prompt, history = [], transcriptContext = []) {
  const directDraft = extractDraftForScript(prompt);
  if (directDraft && directDraft.length > 80) {
    return { type: "draft", text: directDraft };
  }
  const previousUser = previousHistoryMessage(history, "user", prompt);
  if (previousUser && previousUser.length > 80) {
    return { type: "previous-user", text: extractDraftForScript(previousUser) };
  }
  const previousAssistant = previousHistoryMessage(history, "assistant", prompt);
  const assistantHook = extractHookFromAssistantHistory(previousAssistant);
  if (assistantHook) {
    return { type: "assistant-hook", text: assistantHook, source: previousAssistant };
  }
  const lead = Array.isArray(transcriptContext) ? transcriptContext[0] : null;
  if (lead?.title || lead?.openingLine) {
    return { type: "transcript-lead", text: compactChatText(lead.title || lead.openingLine, 180) };
  }
  return { type: "none", text: "" };
}

function firstSentence(value, fallback = "") {
  const text = compactChatText(value || "", 220);
  if (!text) return fallback;
  return text.split(/(?<=[.!?])\s+/)[0] || text;
}

function stripLeadInPhrase(value = "") {
  return String(value || "")
    .replace(/^(have you ever wished\s+)/i, "")
    .replace(/^(what if\s+)/i, "")
    .replace(/^(imagine\s+)/i, "")
    .replace(/^(here'?s\s+)/i, "")
    .trim();
}

function reelTopicFromLead(lead, fallback = "your business") {
  const title = compactChatText(lead?.title || "", 220);
  if (title && !/^untitled reel$/i.test(title)) return stripLeadInPhrase(title.replace(/\.\.\.$/, "")) || fallback;
  const opener = compactChatText(lead?.openingLine || "", 220);
  return stripLeadInPhrase(opener) || fallback;
}

function buildWordForWordScript({ lead, hook, pillar, topicHint, openerStyle, referenceLine }) {
  const openingClaim = firstSentence(openerStyle, "Most founders are missing the real reason this works.");
  const lineStyle = firstSentence(referenceLine, "");
  const topic = stripLeadInPhrase(topicHint || reelTopicFromLead(lead, "your business")) || "your business";
  const pillarLabel = String(pillar || "your lane").toLowerCase();
  const beat2 = lineStyle
    ? compactChatText(lineStyle, 160)
    : `The interesting part is not the tool itself. The interesting part is what it lets a business owner do faster, cheaper, or with less friction.`;
  const beat3 = /crore|lakh|million|billion|%|\d/i.test(openingClaim)
    ? `That is exactly why this kind of reel works. The number gets attention, but the real hook is the shortcut behind the number.`
    : `Most people stop at the surface claim. The better reel is the one that shows the hidden mechanism behind the claim.`;
  const beat4 = `So if you are making content in ${pillarLabel}, do not explain everything. Land one sharp claim, show one proof point, and make the viewer feel smarter in under 40 seconds.`;
  const close = `That is the format I would double down on for the next reel. Save this if you want more scripts built from your own winning patterns.`;
  return [
    openingClaim,
    beat2,
    beat3,
    beat4,
    close
  ].map((line) => compactChatText(line.replace(/\s+/g, " ").trim(), 220));
}

function chatFullScriptAnswer(prompt, dashboard, transcriptContext = [], history = []) {
  const context = buildContextSummary(dashboard);
  const { lead } = selectTranscriptPattern(transcriptContext);
  const source = scriptSourceFromContext(prompt, history, transcriptContext);
  const draft = source.text;
  const hook = lead?.hook || context.hookLeader?.label || "Data Hook";
  const pillar = transcriptPatternPillar(lead, context);
  const openerStyle = lead?.openingLine || "Most people are missing the real reason this is happening.";
  const referenceLine = lead?.matchedSnippet && lead?.matchedSnippet !== openerStyle ? lead.matchedSnippet : "";
  const workingHook = extractHookFromAssistantHistory(source.source || "") || firstSentence(draft, openerStyle);
  const topicHint = compactChatText(draft || lead?.title || "this topic", 120);
  const hasConcreteSource = Boolean(draft);
  const scriptLines = buildWordForWordScript({
    lead,
    hook,
    pillar,
    topicHint,
    openerStyle: workingHook || openerStyle,
    referenceLine
  });

  return [
    "Verdict",
    hasConcreteSource
      ? `Yes, this can work for your past pattern if you keep it as a ${hook} inside ${pillar}. The key is to reduce it to one sharp tension, not five competing points.`
      : `I can use your transcript pattern here, but I do not have a full draft/topic in this message. So I am grounding this script in the strongest available thread context and your saved transcript pattern.`,
    "",
    "Ready-to-record reel script",
    `Hook (0-3s): ${scriptLines[0]}`,
    "",
    `Beat 1 (3-10s): ${scriptLines[1]}`,
    "",
    `Beat 2 (10-22s): ${scriptLines[2]}`,
    "",
    `Beat 3 (22-35s): ${scriptLines[3]}`,
    "",
    `Close (35-45s): ${scriptLines[4]}`,
    "",
    "On-screen text",
    `${compactChatText(scriptLines[0], 90)} | Hidden mechanism | One clear takeaway`,
    "",
    "Delivery",
    "Direct-to-camera, fast founder tone. First frame should land the claim instantly. Keep cuts tight, use one visual proof moment, and do not add a second topic midway.",
    "",
    "What to copy from your winning transcripts",
    `Open specific like: "${compactChatText(openerStyle, 140)}"`,
    referenceLine ? `Use one punchy supporting line style like: "${compactChatText(referenceLine, 150)}"` : "Keep every beat as one clean claim followed by one proof point.",
    "",
    transcriptConfidenceLine(transcriptContext),
    "",
    "Next action",
    hasConcreteSource
      ? "If you want, send the exact draft again and I will tighten this into a final word-for-word recording script."
      : "If you want a precise final script, send the exact topic/draft in one message. Right now this is pattern-grounded, not draft-grounded."
  ].filter(Boolean).join("\n\n");
}

function analyticsConfidenceLine(dashboard, sampleSize = 0, fallbackReason = "broad dashboard evidence") {
  const confidence = confidenceBand(sampleSize || dashboard.summary?.posts || 0);
  return `Confidence: ${confidence.label} confidence. Reason: ${confidence.reason || fallbackReason}.`;
}

function reelPerformanceScore(reel) {
  return Number(reel.views || 0)
    + Number(reel.saves || 0) * 12
    + Number(reel.comments || 0) * 8
    + Number(reel.retention || 0) * 500
    + Number(reel.watchTime || 0) * 40;
}

function auditPatternGroups(reels = []) {
  const buckets = new Map();
  reels.forEach((reel) => {
    const hook = String(reel.hook || "Unknown").trim();
    const pillar = String(reel.pillar || "General").trim();
    const strategy = String(reel.strategy || "Direct").trim();
    const key = `${hook}__${pillar}__${strategy}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        hook,
        pillar,
        strategy,
        posts: 0,
        views: 0,
        saves: 0,
        comments: 0,
        retention: 0,
        watchTime: 0,
        examples: []
      });
    }
    const bucket = buckets.get(key);
    bucket.posts += 1;
    bucket.views += Number(reel.views || 0);
    bucket.saves += Number(reel.saves || 0);
    bucket.comments += Number(reel.comments || 0);
    bucket.retention += Number(reel.retention || 0);
    bucket.watchTime += Number(reel.watchTime || 0);
    bucket.examples.push(reel);
  });
  return [...buckets.values()]
    .map((bucket) => {
      const rankedExamples = [...bucket.examples].sort((left, right) => reelPerformanceScore(right) - reelPerformanceScore(left));
      const avgViews = bucket.posts ? bucket.views / bucket.posts : 0;
      const avgSaves = bucket.posts ? bucket.saves / bucket.posts : 0;
      const avgComments = bucket.posts ? bucket.comments / bucket.posts : 0;
      const avgRetention = bucket.posts ? bucket.retention / bucket.posts : 0;
      const avgWatchTime = bucket.posts ? bucket.watchTime / bucket.posts : 0;
      return {
        ...bucket,
        avgViews,
        avgSaves,
        avgComments,
        avgRetention,
        avgWatchTime,
        label: `${bucket.hook} + ${bucket.pillar} + ${bucket.strategy}`,
        score: avgViews + avgSaves * 12 + avgComments * 8 + avgRetention * 500 + avgWatchTime * 40,
        topExample: rankedExamples[0] || null
      };
    });
}

function formatPatternAuditLine(pattern, index, mode = "winning") {
  const title = compactChatText(pattern?.topExample?.title || "Untitled reel", 72);
  const views = fmtCompact(Number(pattern?.avgViews || 0));
  const retention = fmtPercent(Number(pattern?.avgRetention || 0), 1);
  const watch = `${Number(pattern?.avgWatchTime || 0).toFixed(1)}s`;
  const saves = fmtCompact(Number(pattern?.avgSaves || 0));
  const prefix = `${index + 1}. ${pattern.label}`;
  if (mode === "weak") {
    return `${prefix}: ${pattern.posts} posts, only ${views} avg views, ${retention} retention, ${watch} avg watch time. Weak example signal: "${title}".`;
  }
  return `${prefix}: ${pattern.posts} posts, ${views} avg views, ${retention} retention, ${watch} avg watch time, ${saves} avg saves. Best example: "${title}".`;
}

function topCompetitorTranscriptSnapshot(dashboard) {
  const competitorReels = Array.isArray(dashboard.competitorReels) ? dashboard.competitorReels : [];
  const withTranscript = competitorReels.filter((reel) => hasTranscriptPayload(reel));
  if (!withTranscript.length) return null;
  const topReel = [...withTranscript].sort((left, right) => reelPerformanceScore(right) - reelPerformanceScore(left))[0];
  const sourceHandle = String(topReel.sourceHandle || "").replace(/^@/, "").trim().toLowerCase();
  const competitor = (dashboard.competitors || []).find((item) => String(item.canonicalHandle || item.handle || "").trim().toLowerCase() === sourceHandle)
    || (dashboard.competitors || []).find((item) => String(item.name || "").trim().toLowerCase() === String(topReel.sourceName || "").trim().toLowerCase())
    || null;
  return { topReel, competitor };
}

function chatCompetitorMomentumAnswer(prompt, dashboard) {
  const competitor = matchedCompetitorFromPrompt(prompt, dashboard);
  if (!competitor) return "";
  const reels = Array.isArray(competitor.reels) ? competitor.reels : [];
  const avgViews = reels.length ? avg(reels, "views") : 0;
  const topHook = competitor.topHook || competitorHookLabel(competitor);
  const topFormat = competitor.bestFormat || "short video";
  const leadReel = reels[0];
  const confidence = confidenceBand(reels.length);
  return [
    `Breakdown: ${competitor.name} is moving with ${competitor.monthlyGrowthLabel || "tracked momentum"} right now.`,
    `Evidence: the visible pattern is ${topFormat} format plus ${topHook} packaging, and the tracked set is averaging ${fmtCompact(avgViews)} views per reel.${leadReel?.title ? ` The clearest recent example is "${compactChatText(leadReel.title, 110)}".` : ""}`,
    `Confidence: ${confidence.label} confidence. Reason: ${confidence.reason}.`,
    "Next action: study the structure, topic packaging, and proof style here, then rebuild the same psychology in your own voice instead of copying the delivery."
  ].join("\n\n");
}

function chatAllReelsAnalysisAnswer(dashboard) {
  const context = buildContextSummary(dashboard);
  const topReel = context.topReel;
  const posts = Number(dashboard.summary?.posts || dashboard.posts?.length || 0);
  const safeTopViews = Number.isFinite(Number(topReel?.views)) ? fmtCompact(Number(topReel.views)) : "";
  const topViewsLabel = topReel?.viewsLabel && !/nan/i.test(String(topReel.viewsLabel)) ? topReel.viewsLabel : safeTopViews;
  const transcriptPosts = (dashboard.posts || []).filter((reel) => hasTranscriptPayload(reel));
  const patternGroups = auditPatternGroups(transcriptPosts.length ? transcriptPosts : (dashboard.posts || []));
  const winningPatterns = [...patternGroups]
    .filter((pattern) => pattern.posts >= 1)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
  const weakPatterns = [...patternGroups]
    .filter((pattern) => pattern.posts >= 1)
    .sort((left, right) => left.avgRetention - right.avgRetention || left.avgViews - right.avgViews)
    .slice(0, 5);
  const stopPattern = weakPatterns[0] || null;
  const doubleDownPattern = winningPatterns[0] || null;
  const competitorSnapshot = topCompetitorTranscriptSnapshot(dashboard);
  const competitorLine = competitorSnapshot?.topReel
    ? `${competitorSnapshot.competitor?.name || competitorSnapshot.topReel.sourceName || competitorSnapshot.topReel.sourceHandle} is the clearest competitor transcript benchmark right now. Their strongest visible reel uses ${competitorSnapshot.topReel.hook} packaging in ${competitorSnapshot.topReel.pillar}, opens with "${compactChatText(normalizeTimestampedTranscript(competitorSnapshot.topReel.timestampedTranscript)[0]?.text || competitorSnapshot.topReel.scriptSummary?.[0] || competitorSnapshot.topReel.transcript, 140)}", and wins through faster clarity than most of your weaker reels.`
    : "Competitor transcript comparison is limited right now because no imported competitor transcript set is strong enough in the current range.";
  const creatorComparison = doubleDownPattern?.topExample
    ? `Your strongest repeatable creator pattern is ${doubleDownPattern.label}. The best example is "${compactChatText(doubleDownPattern.topExample.title || doubleDownPattern.topExample.caption, 88)}", which suggests that direct specificity plus a clean first-frame promise is still your highest-signal packaging.`
    : `Your strongest repeatable creator pattern is ${context.hookLeader.label} inside ${context.pillarLeader.label}.`;
  return [
    "Catalogue audit",
    `Finding: across ${posts} reels, your catalogue is strongest when it stays inside ${context.hookLeader.label} style packaging and turns one idea into one clear promise.${topReel?.title ? ` The current visible winner is "${compactChatText(topReel.title, 120)}"${topViewsLabel ? ` at ${topViewsLabel} views` : ""}.` : ""}`,
    "",
    "Top 5 winning patterns",
    ...winningPatterns.map((pattern, index) => formatPatternAuditLine(pattern, index, "winning")),
    "",
    "Top 5 weak patterns",
    ...weakPatterns.map((pattern, index) => formatPatternAuditLine(pattern, index, "weak")),
    "",
    "What to stop posting",
    stopPattern
      ? `Reduce ${stopPattern.label} unless you can rebuild the opener. Right now this pattern is creating weak watch depth and low carry-through. The failure is not usually the topic itself, it is that the reel takes too long to declare the payoff.`
      : "No clear stop-pattern yet because the current range is too mixed.",
    "",
    "What to double down on",
    doubleDownPattern
      ? `Do more of ${doubleDownPattern.label}. It is your cleanest repeatable winner because it combines immediate clarity with stronger average saves, retention, and watch time than the rest of the catalogue. Build the next 3-5 reels in this lane before expanding sideways.`
      : `Double down on ${context.hookLeader.label} inside ${context.pillarLeader.label}.`,
    "",
    "Creator vs competitor transcript comparison",
    creatorComparison,
    competitorLine,
    "Gap: your weaker reels often sound like they are still setting up the idea, while the stronger competitor examples tend to land the claim immediately and then justify it in one or two beats.",
    "",
    analyticsConfidenceLine(dashboard, posts),
    "Next action: use this audit as a packaging decision system. Keep one winning lane, kill one weak lane, and ask me next for `turn the top winning pattern into 5 reel ideas` or `compare my reels vs competitor transcript line by line`."
  ].join("\n");
}

function chatBestReelAnalysisAnswer(dashboard) {
  const topReel = dashboard.topReels?.[0] || null;
  if (!topReel) {
    return [
      "Best-reel analysis",
      "I could not find a top reel in the current filtered range.",
      "Next action: widen the date range or remove filters, then ask again."
    ].join("\n\n");
  }
  const title = compactChatText(topReel.title || topReel.caption || "Untitled reel", 140);
  const hook = topReel.hook || "direct hook";
  const pillar = topReel.pillar || "your current lane";
  const format = topReel.format || topReel.strategy || topReel.platform || "short-form video";
  const evidenceBits = [
    topReel.viewsLabel ? `${topReel.viewsLabel} views` : "",
    topReel.likesLabel ? `${topReel.likesLabel} likes` : "",
    topReel.commentsLabel && topReel.commentsLabel !== "0" ? `${topReel.commentsLabel} comments` : "",
    topReel.savesLabel && topReel.savesLabel !== "0" ? `${topReel.savesLabel} saves` : "",
    topReel.engagementRateLabel && topReel.engagementRateLabel !== "N/A" ? `${topReel.engagementRateLabel} engagement` : "",
    topReel.watchTimeLabel ? `${topReel.watchTimeLabel} watch time` : ""
  ].filter(Boolean).join(", ");
  return [
    "Best-reel analysis",
    `Finding: your current best reel is "${title}", and it is winning because it packages a ${hook} inside ${pillar} with a format that is fast to parse.`,
    `Evidence: this reel is leading the filtered set${evidenceBits ? ` at ${evidenceBits}` : ""}. The repeatable pattern is one clean promise up front, low confusion in the first frame, and a topic that can be understood immediately.`,
    analyticsConfidenceLine(dashboard, dashboard.summary?.posts || 0),
    `Next action: do not copy the topic word-for-word. Copy the packaging instead: keep the opener style close to ${hook}, stay inside ${pillar}, and rebuild the next reel in a ${String(format).toLowerCase()} format with one sharper proof point.`
  ].join("\n\n");
}

function chatAllScriptsAuditAnswer(dashboard) {
  const transcriptPosts = (dashboard.posts || []).filter((reel) => hasTranscriptPayload(reel));
  const posts = transcriptPosts.length;
  const patterns = auditPatternGroups(transcriptPosts);
  const winners = [...patterns].sort((left, right) => right.score - left.score).slice(0, 5);
  const weak = [...patterns].sort((left, right) => left.avgViews - right.avgViews || left.avgWatchTime - right.avgWatchTime).slice(0, 5);
  const openings = transcriptPosts
    .slice()
    .sort((left, right) => reelPerformanceScore(right) - reelPerformanceScore(left))
    .slice(0, 5)
    .map((reel, index) => {
      const opening = normalizeTimestampedTranscript(reel.timestampedTranscript)[0]?.text || reel.scriptSummary?.[0] || reel.transcript || reel.caption || "";
      return `${index + 1}. "${compactChatText(opening, 150)}" -> ${reel.hook} / ${reel.strategy || "strategy"} / ${reel.viewsLabel || fmtCompact(reel.views)} views`;
    });
  return [
    "Script audit",
    `I found ${posts} reels with transcript/script evidence in the current dashboard. The strongest scripts are not winning because they are longer; they win because the first line makes the topic obvious fast, then the middle gives one business insight instead of general commentary.`,
    "",
    "Top script patterns to copy",
    ...winners.map((pattern, index) => formatPatternAuditLine(pattern, index, "winning")),
    "",
    "Weak script patterns to reduce",
    ...weak.map((pattern, index) => formatPatternAuditLine(pattern, index, "weak")),
    "",
    "Best opening styles from your scripts",
    ...(openings.length ? openings : ["No clean transcript openings found in this range."]),
    "",
    "What to fix",
    "1. Start with the payoff, not the setup. If the reel needs two sentences before the viewer knows why to care, cut the first sentence.",
    "2. Keep one idea per reel. Your weaker scripts drift from story to explanation to generic takeaway.",
    "3. Replace broad founder advice with one concrete mechanism: cost, distribution, retention, policy, timing, or consumer behavior.",
    "4. Reuse the structure of winning hooks, but change the visual angle and first-frame text so it does not feel like a repost.",
    "",
    "Next script rule",
    "Use this structure for the next 5 reels: counter-intuitive first line -> one proof point -> hidden business mechanism -> opinionated founder takeaway -> soft save CTA.",
    "",
    analyticsConfidenceLine(dashboard, posts)
  ].join("\n");
}

function chatOutshineStrategyAnswer(dashboard) {
  const context = buildContextSummary(dashboard);
  const transcriptPosts = (dashboard.posts || []).filter((reel) => hasTranscriptPayload(reel));
  const patterns = auditPatternGroups(transcriptPosts.length ? transcriptPosts : dashboard.posts || []);
  const winner = [...patterns].sort((left, right) => right.score - left.score)[0];
  const weak = [...patterns].sort((left, right) => left.avgViews - right.avgViews || left.avgWatchTime - right.avgWatchTime)[0];
  const competitorSnapshot = topCompetitorTranscriptSnapshot(dashboard);
  const competitor = competitorSnapshot?.competitor || context.topCompetitor;
  const competitorOpening = competitorSnapshot?.topReel
    ? normalizeTimestampedTranscript(competitorSnapshot.topReel.timestampedTranscript)[0]?.text || competitorSnapshot.topReel.scriptSummary?.[0] || competitorSnapshot.topReel.transcript || ""
    : "";
  return [
    "Outshine strategy",
    `Direct answer: to outshine, stop trying to cover more topics. You need sharper packaging around the patterns already working: ${context.hookLeader?.label || "your top hook"} hooks, ${context.pillarLeader?.label || "your strongest pillar"}, and scripts that reveal one hidden business mechanism quickly.`,
    "",
    "Evidence from your content",
    winner ? `Your best repeatable lane is ${winner.label}: ${winner.posts} posts, ${fmtCompact(winner.avgViews)} avg views, ${fmtPercent(winner.avgRetention, 1)} retention, ${Number(winner.avgWatchTime || 0).toFixed(1)}s avg watch time.` : "No clear winner pattern found yet.",
    weak ? `Your weakest lane is ${weak.label}: ${weak.posts} posts, ${fmtCompact(weak.avgViews)} avg views, ${fmtPercent(weak.avgRetention, 1)} retention. This is the lane to reduce or rebuild.` : "",
    "",
    "Competitor reference",
    competitor ? `${competitor.name || competitor.canonicalHandle} is the benchmark to watch right now. Their visible edge is ${competitor.topHook || "clear hook packaging"} with ${competitor.bestFormat || "short video"} format.` : "No competitor benchmark is strong enough in the current tracker.",
    competitorOpening ? `Competitor transcript opener to learn from: "${compactChatText(competitorOpening, 150)}". Study the speed and clarity, not the wording.` : "",
    "",
    "What to do next",
    "1. Make every first line a claim, not context.",
    "2. Pick one recurring lane for the next 7 days and publish variations instead of changing pillar every reel.",
    "3. Add one hard proof point by second 8: data, money, geography, time, consumer behavior, or distribution.",
    "4. End with an opinionated business takeaway. Avoid generic CTAs like 'drop your thoughts'.",
    "5. Compare every new script against your strongest transcript opener before posting.",
    "",
    "Next content direction",
    winner
      ? `Double down on ${winner.label}. Build 3 reels from this lane: one data shock, one founder story, and one competitor teardown.`
      : `Double down on ${context.hookLeader?.label || "your strongest hook"} inside ${context.pillarLeader?.label || "your strongest pillar"}.`,
    "",
    analyticsConfidenceLine(dashboard, dashboard.summary?.posts || transcriptPosts.length || 0)
  ].join("\n");
}

function fallbackChat(prompt, dashboard, selectedStory = null) {
  const cleanPrompt = String(prompt || "").trim();
  const query = cleanPrompt.toLowerCase();
  const context = buildContextSummary(dashboard);
  const transcriptLead = context.transcriptContext?.[0] || null;

  if (!cleanPrompt || cleanPrompt.length < 6) {
    return {
      answer: `Your message is too short to answer properly from analytics. Ask something specific like:\n- Why did my last reel underperform?\n- What should I post next?\n- Which competitor angle is moving fastest?\n- Turn the top news story into a reel angle.`,
      citations: []
    };
  }

  if (query.includes("underperform") || query.includes("last reel")) {
    return {
      answer: [
        `Diagnosis: your weaker reels are underperforming because their opening pattern is not matching ${context.hookLeader.label}, which is the current retention leader.`,
        `Evidence: ${context.hookLeader.label} is averaging ${fmtPercent(context.hookLeader.avgRetention)} retention in the current set, while your recent weak reels are falling short of that opening strength.`,
        analyticsConfidenceLine(dashboard, dashboard.summary?.posts || 0),
        "Next action: re-cut the first 3 seconds of the last weak reel, swap in a sharper opener, and republish near your highest-scoring posting slot."
      ].join("\n\n"),
      citations: [dashboard.insights[1]?.citation, dashboard.insights[3]?.citation].filter(Boolean)
    };
  }

  if ((query.includes("why is my") || query.includes("working right now") || query.includes("why is")) && (query.includes("pillar") || query.includes("content") || query.includes("founder story") || query.includes("growth"))) {
    return {
      answer: [
        `Finding: ${context.pillarLeader.label} is working because it is your highest-output pillar and it is being amplified by ${context.hookLeader.label} openings.`,
        `Evidence: inside your saved analytics, that pillar + hook combination is doing the best job of holding attention and concentrating views around the strongest posting windows.`,
        analyticsConfidenceLine(dashboard, dashboard.summary?.posts || 0),
        `Next action: keep the next 3-5 reels inside ${context.pillarLeader.label}, but vary the example or proof point instead of changing the pillar.`
      ].join("\n\n"),
      citations: [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation, dashboard.insights[3]?.citation].filter(Boolean)
    };
  }

  if (query.includes("post") && query.includes("next")) {
    const transcriptAngle = transcriptLead
      ? ` Your closest winning transcript example is "${transcriptLead.title}", which opens with "${transcriptLead.openingLine}" and leans into ${String(transcriptLead.strategy || "a direct creator-native delivery").toLowerCase()}.`
      : "";
    return {
      answer: `${chatNextPostAnswer(dashboard, context.transcriptContext || [])}${transcriptAngle}`,
      citations: [dashboard.insights[0]?.citation, dashboard.insights[2]?.citation, dashboard.insights[3]?.citation].filter(Boolean)
    };
  }

  if (isCompetitorMomentumRequest(cleanPrompt, dashboard)) {
    return {
      answer: chatCompetitorMomentumAnswer(cleanPrompt, dashboard),
      citations: [{ view: "competitors", section: "competitorsTable", label: "Competitor tracker" }]
    };
  }

  if (isAllReelsAnalysisRequest(cleanPrompt)) {
    return {
      answer: chatAllReelsAnalysisAnswer(dashboard),
      citations: [
        { view: "performance", section: "kpiGrid", label: "Dashboard KPIs" },
        dashboard.insights[0]?.citation
      ].filter(Boolean)
    };
  }

  if (isAllScriptsAnalysisRequest(cleanPrompt)) {
    return {
      answer: chatAllScriptsAuditAnswer(dashboard),
      citations: [
        { view: "performance", section: "allPostsTable", label: "Creator transcripts" },
        { view: "performance", section: "hookChart", label: "Hook performance" }
      ]
    };
  }

  if (isOutshineStrategyRequest(cleanPrompt)) {
    return {
      answer: chatOutshineStrategyAnswer(dashboard),
      citations: [
        { view: "performance", section: "allPostsTable", label: "Creator transcripts" },
        { view: "competitors", section: "competitorsTable", label: "Competitor references" }
      ]
    };
  }

  if (isBestReelAnalysisRequest(cleanPrompt)) {
    return {
      answer: chatBestReelAnalysisAnswer(dashboard),
      citations: [
        { view: "performance", section: "topPerformers", label: "Top performers" },
        { view: "performance", section: "allPostsTable", label: "Reel-level breakdown" }
      ]
    };
  }

  if (isFullScriptRequest(cleanPrompt)) {
    return {
      answer: chatFullScriptAnswer(cleanPrompt, dashboard, context.transcriptContext || []),
      citations: [
        { view: "performance", section: "allPostsTable", label: "Transcript examples" },
        dashboard.insights[0]?.citation
      ].filter(Boolean)
    };
  }

  if (query.includes("competitor")) {
    return {
      answer: [
        `Finding: ${context.topCompetitor.name} is the fastest-moving competitor right now at ${context.topCompetitor.monthlyGrowthLabel}.`,
        `Evidence: the visible format lifting them is ${context.topCompetitor.bestFormat}, which makes them the strongest current watchlist signal in your competitor set.`,
        "Confidence: Medium confidence. Reason: this comes from tracked competitor momentum, not full causal attribution.",
        "Next action: study their structure and topic packaging, but translate it into your own trust-led voice instead of copying delivery."
      ].join("\n\n"),
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
      answer: [
        `Finding: ${context.hookLeader.label} hooks and ${context.pillarLeader.label} posts are driving the strongest save behavior right now.`,
        "Evidence: those formats are converting attention into save intent better than the rest of the current mix.",
        analyticsConfidenceLine(dashboard, dashboard.summary?.posts || 0),
        `Next action: make your next save-optimized reel inside ${context.pillarLeader.label} and package the first line with a ${context.hookLeader.label} opener.`
      ].join("\n\n"),
      citations: [{ view: "performance", section: "hookChart", label: "Hook comparison" }]
    };
  }

  if (transcriptLead && isTranscriptStrategyRequest(cleanPrompt)) {
    return {
      answer: [
        `Closest transcript-backed pattern right now is "${transcriptLead.title}".`,
        `Evidence: it opens with "${transcriptLead.openingLine}", sits in ${transcriptLead.pillar}, and the strongest matched phrasing is "${transcriptLead.matchedSnippet}".`,
        transcriptConfidenceLine(context.transcriptContext || []),
        "Next action: ask for next-post planning, hook rewrite, or reel script and I will use this transcript pattern directly."
      ].join("\n\n"),
      citations: [
        { view: "performance", section: "allPostsTable", label: "Transcript examples" },
        dashboard.insights[0]?.citation
      ].filter(Boolean)
    };
  }

  return {
    answer: [
      `I could not map "${cleanPrompt}" to one precise task, so here is the closest analytics-backed read.`,
      `Evidence: ${context.hookLeader.label} is your strongest hook pattern, ${context.pillarLeader.label} is your leading pillar, and ${context.topCompetitor.name} is the fastest-moving competitor in the current tracker.`,
      analyticsConfidenceLine(dashboard, dashboard.summary?.posts || 0),
      "Next action: ask for monthly summary, weekly plan, transcript script, competitor breakdown, news angle, or re-cut audit for a sharper answer."
    ].join("\n\n"),
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
              text: "You are CreatorOS, a creator strategist that improves decisions using only creator-specific evidence. Use only the provided dashboard context. Transcript context has highest priority for proven wording, pacing, openers, structure, and reusable phrasing. Never invent metrics, history, competitors, or certainty. If evidence is weak, say so. Prefer explainable recommendations over generic advice. Every recommendation should make clear why this, why now, what to copy, what to avoid, and what to do next. If a selected story is provided and the user asks for a reel, answer only for that exact story. Default to long-form answers with clear sections, not compressed blurbs. Use headings when helpful. When useful, include a confidence line based on available evidence."
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
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ]
  };
  if (responseFormat) {
    payload.generationConfig = {
      responseMimeType: "application/json",
      responseSchema: responseFormat
    };
  }

  let lastError = null;
  for (const modelName of geminiModelCandidates) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const result = await response.json();
      if (result) {
        result._model = modelName;
        return result;
      }
    }

    const details = await response.text();
    lastError = new Error(`Gemini request failed with ${response.status}${details ? `: ${details}` : ""}`);
    if (![429, 500, 503].includes(response.status)) {
      throw lastError;
    }
  }

  throw lastError || new Error("Gemini request failed.");
}

function isGeminiRequiredChatRequest(prompt) {
  const query = String(prompt || "").trim().toLowerCase();
  if (!query) return false;
  if (query.length < 6) return false;
  return /\b(analy[sz]e|audit|breakdown|strategy|outshine|ideas?|script|rewrite|next|post|reel|hook|caption|competitor|transcript|content|improve|what should|what i have)\b/.test(query);
}

function geminiUnavailableAnswer(error = null) {
  const detail = error?.message ? ` (${compactChatText(error.message, 140)})` : "";
  return [
    "Gemini could not complete this answer right now.",
    `I am not returning a local fallback because this question needs the transcript, hook, strategy, and competitor context to be analyzed properly${detail}.`,
    "Retry the question once Gemini is responsive, or reduce the request scope if the prompt is very large."
  ].join("\n\n");
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
      "Use transcriptContext when present as the highest-priority examples of the creator's proven wording, openers, pacing, and structure.",
      "Prefer transcriptContext openingLine and matchedSnippet fields over generic summaries.",
      "If selected story context is provided, prioritize that exact story instead of a generic top-news answer.",
      "If the user asks to turn a selected news story into a reel, give one detailed reel brief only.",
      "Default to long-form answers.",
      "Use clear sections such as Finding, Evidence, What This Means, What To Copy, What To Avoid, and Next Action whenever they fit.",
      "Do not provide multiple disconnected options unless the user explicitly asks for options.",
      "Do not repeat the same point in slightly different wording.",
      "Aim for roughly 350-700 words when the question is analytical, and 220-450 words for compact tactical asks.",
      "Be practical, detailed, and grounded in the store data.",
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

async function geminiTranscriptStrategyChat(prompt, dashboard) {
  if (!geminiApiKey) return null;
  const context = buildContextSummary(dashboard);
  const transcriptContext = Array.isArray(context.transcriptContext) ? context.transcriptContext.slice(0, 5) : [];
  if (!transcriptContext.length) {
    return {
      answer: transcriptStrategyFallbackAnswer(prompt, dashboard, transcriptContext),
      citations: [{ view: "performance", section: "allPostsTable", label: "Transcript examples" }]
    };
  }

  const result = await geminiTextInteraction({
    prompt: [
      "You are a short-form creator strategy analyst.",
      "The user wants ideas, analysis, hooks, rewrites, or scripts based on saved reel transcripts.",
      "You are CreatorOS, not a generic assistant. Improve the creator's next decision, do not just describe patterns.",
      "Use transcriptContext as the primary source. Do not give generic social media advice.",
      "When competitor transcript examples are present in transcriptContext, you may analyze them too, but stay explicit about whether a point comes from creator or competitor reels.",
      "Extract the proven opener pattern, pacing, language, and content angle from the provided transcript snippets.",
      "Do not invent metrics. If metrics are missing, ignore them.",
      "If evidence is weak or sample size is small, say so plainly.",
      "Answer in Hinglish-friendly concise English.",
      "Format exactly with these blocks:",
      "1. Transcript Pattern",
      "2. What To Copy",
      "3. What To Avoid",
      "4. Reel-Level Observations",
      "5. New Ideas",
      "6. Ready Hook",
      "7. Execution",
      "8. Confidence",
      "9. Next Action",
      "For Reel-Level Observations, mention concrete transcript-backed patterns or failure points from the matched reels.",
      "For New Ideas, give 5 specific ideas. For Execution, include scene-by-scene beats for the strongest idea.",
      "Keep it detailed and useful, around 700-1100 words.",
      "",
      `Dashboard context: ${JSON.stringify({
        creator: context.creator,
        kpis: context.kpis,
        hookLeader: context.hookLeader,
        pillarLeader: context.pillarLeader,
        transcriptContext
      })}`,
      "",
      `User ask: ${prompt}`
    ].join("\n")
  });

  return {
    answer: interactionOutputText(result) || transcriptStrategyFallbackAnswer(prompt, dashboard, transcriptContext),
    citations: [
      { view: "performance", section: "allPostsTable", label: "Transcript examples" },
      dashboard.insights[0]?.citation
    ].filter(Boolean)
  };
}

async function geminiFullScriptChat(prompt, dashboard, history = []) {
  if (!geminiApiKey) return null;
  const context = buildContextSummary(dashboard);
  const transcriptContext = Array.isArray(context.transcriptContext) ? context.transcriptContext.slice(0, 3) : [];
  if (!transcriptContext.length) return null;
  const { lead } = selectTranscriptPattern(transcriptContext);
  const source = scriptSourceFromContext(prompt, history, transcriptContext);
  const previousUser = previousHistoryMessage(history, "user", prompt);
  const previousAssistant = previousHistoryMessage(history, "assistant", prompt);
  const result = await geminiTextInteraction({
    prompt: [
      "You are CreatorOS, a reel scriptwriter for a creator intelligence product.",
      "The user wants a next reel script that is ready to record right now.",
      "Use transcriptContext as the highest-priority evidence for opener style, pacing, proof style, and language.",
      "If thread history contains a previous plan, hook, or angle, use it as supporting context.",
      "You must anchor the script to the provided Primary Script Seed. Do not invent a completely new topic, business model, or category unless the seed explicitly contains it.",
      "If the prompt is generic, use the strongest transcript lead and seed as the topic source. Do not wander into unrelated examples.",
      "Write actual spoken lines. Do not write placeholders like 'add a proof point here' or 'explain the mechanism'.",
      "Keep the script in one lane. Do not switch topic midway.",
      "If evidence is weak, still write the strongest script you can, but say confidence is low.",
      "Confidence must be Low when the primary transcript seed has 0 views, missing metrics, or fewer than 10 strong transcript matches. Do not claim High confidence from style match alone.",
      "Use Hinglish-friendly concise English.",
      "Format exactly with these blocks:",
      "1. Script Angle",
      "2. Final Script",
      "3. On-screen Text",
      "4. Delivery Notes",
      "5. Why This Should Work",
      "6. Confidence",
      "Final Script must be a word-for-word 35-50 second reel script.",
      "Do not output multiple script options.",
      "",
      `Context: ${JSON.stringify({
        creator: context.creator,
        hookLeader: context.hookLeader,
        pillarLeader: context.pillarLeader,
        topReel: context.topReel,
        transcriptContext,
        transcriptEvidenceCount: transcriptContext.length,
        primarySeedViews: Number(lead?.views || 0)
      })}`,
      `Primary script seed: ${JSON.stringify({
        sourceType: source.type,
        sourceText: source.text,
        transcriptLeadTitle: lead?.title || "",
        transcriptLeadOpeningLine: lead?.openingLine || "",
        transcriptLeadSnippet: lead?.matchedSnippet || ""
      })}`,
      `Previous user context: ${JSON.stringify(previousUser || "")}`,
      `Previous assistant context: ${JSON.stringify(previousAssistant || "")}`,
      "",
      `User ask: ${prompt}`
    ].join("\n")
  });

  return {
    answer: interactionOutputText(result) || "",
    citations: [
      { view: "performance", section: "allPostsTable", label: "Transcript examples" },
      dashboard.insights[0]?.citation
    ].filter(Boolean)
  };
}

async function geminiNextPostChat(prompt, dashboard, history = []) {
  if (!geminiApiKey) return null;
  const context = buildContextSummary(dashboard);
  const transcriptContext = Array.isArray(context.transcriptContext) ? context.transcriptContext.slice(0, 3) : [];
  if (!transcriptContext.length) return null;
  const { lead } = selectTranscriptPattern(transcriptContext);
  const previousUser = previousHistoryMessage(history, "user", prompt);
  const previousAssistant = previousHistoryMessage(history, "assistant", prompt);
  const result = await geminiTextInteraction({
    prompt: [
      "You are CreatorOS, a next-post generator for a creator intelligence product.",
      "The user wants you to build the next post from saved transcripts. They do not want a planner or meta instructions.",
      "Use transcriptContext as the primary source for opener style, pacing, topic shape, proof style, and delivery.",
      "Generate one concrete next post package that the creator can publish or record.",
      "Do not output generic structure advice. Write actual content.",
      "Keep the post in one lane and anchor it to the Primary Transcript Seed.",
      "Do not invent an unrelated topic. If the seed is about a founder/business story, stay in founder/business analysis.",
      "Use Hinglish-friendly concise English.",
      "Format exactly with these blocks:",
      "1. Next Post Angle",
      "2. Opening Hook",
      "3. Final Reel Script",
      "4. Caption",
      "5. CTA",
      "6. Why This Should Work",
      "7. Confidence",
      "Final Reel Script must be word-for-word and roughly 35-50 seconds.",
      "Opening Hook must include 3 alternate hook lines, but Final Reel Script must use only one.",
      "",
      `Context: ${JSON.stringify({
        creator: context.creator,
        hookLeader: context.hookLeader,
        pillarLeader: context.pillarLeader,
        topReel: context.topReel,
        transcriptContext,
        transcriptEvidenceCount: transcriptContext.length,
        primarySeedViews: Number(lead?.views || 0)
      })}`,
      `Primary Transcript Seed: ${JSON.stringify({
        title: lead?.title || "",
        openingLine: lead?.openingLine || "",
        snippet: lead?.matchedSnippet || "",
        hook: lead?.hook || "",
        pillar: lead?.pillar || "",
        views: lead?.views || 0
      })}`,
      `Previous user context: ${JSON.stringify(previousUser || "")}`,
      `Previous assistant context: ${JSON.stringify(previousAssistant || "")}`,
      "",
      `User ask: ${prompt}`
    ].join("\n")
  });

  return {
    answer: interactionOutputText(result) || "",
    citations: [
      { view: "performance", section: "allPostsTable", label: "Transcript examples" },
      dashboard.insights[0]?.citation,
      dashboard.insights[3]?.citation
    ].filter(Boolean)
  };
}

async function geminiUnifiedChat(prompt, dashboard, history = [], selectedStory = null) {
  if (!geminiApiKey) return null;
  const context = buildContextSummary(dashboard);
  const transcriptContext = (Array.isArray(context.transcriptContext) ? context.transcriptContext.slice(0, 3) : [])
    .map((reel) => ({
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      strategy: reel.strategy,
      openingLine: compactChatText(reel.openingLine, 90),
      matchedSnippet: compactChatText(reel.matchedSnippet, 130),
      views: reel.views
    }));
  const creatorReels = (dashboard.posts || [])
    .slice()
    .sort((left, right) => reelPerformanceScore(right) - reelPerformanceScore(left))
    .slice(0, 2)
    .map((reel) => ({
      id: reel.id,
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      strategy: reel.strategy,
      views: reel.viewsLabel || fmtCompact(reel.views),
      engagementRate: reel.engagementRateLabel,
      watchTime: reel.watchTimeLabel,
      transcriptOpening: compactChatText(normalizeTimestampedTranscript(reel.timestampedTranscript)[0]?.text || reel.scriptSummary?.[0] || "", 90),
      transcriptSnippet: compactChatText(reel.transcript || reel.caption || "", 100)
    }));
  const competitorReels = (dashboard.competitorReels || [])
    .filter((reel) => hasTranscriptPayload(reel))
    .slice()
    .sort((left, right) => reelPerformanceScore(right) - reelPerformanceScore(left))
    .slice(0, 2)
    .map((reel) => ({
      id: reel.id,
      creator: reel.sourceName || reel.sourceHandle,
      handle: reel.sourceHandle,
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      strategy: reel.strategy,
      views: fmtCompact(reel.views),
      transcriptOpening: compactChatText(normalizeTimestampedTranscript(reel.timestampedTranscript)[0]?.text || reel.scriptSummary?.[0] || "", 90),
      transcriptSnippet: compactChatText(reel.transcript || reel.caption || "", 100)
    }));
  const previousUser = previousHistoryMessage(history, "user", prompt);
  const previousAssistant = previousHistoryMessage(history, "assistant", prompt);
  const result = await geminiTextInteraction({
    prompt: [
      "You are CreatorOS, the live AI strategist inside a creator intelligence product.",
      "Use the current dashboard range only. The transcript evidence in this request already reflects the selected range and filters; do not pull in older evidence outside it.",
      "Answer with the creator's own data first: transcripts, hook performance, strategy tags, top/weak patterns, competitor references, KPIs, and selected story context if present.",
      "Do not give generic advice. Every recommendation must clearly connect back to the provided evidence.",
      "If the user asks for a script, idea, next post, hook, caption, audit, competitor breakdown, or strategy, produce the actual usable output, not a planner explaining what to do.",
      "When transcript evidence exists, use transcript wording, opener rhythm, pacing, and strategy tags as the primary creative reference.",
      "When competitor evidence exists, compare it with the creator's pattern, but do not copy competitor wording directly.",
      "If evidence is weak or the range is small, say confidence is low and explain what is missing.",
      "Be consistent: the same question type should return the same structure.",
      "Use Hinglish-friendly concise English and keep the answer detailed but scannable.",
      "Recommended answer format:",
      "1. Direct Answer",
      "2. Evidence From Your Data",
      "3. What To Copy",
      "4. What To Avoid",
      "5. What To Do Next",
      "6. Confidence",
      "7. References Used",
      "Do not force all sections if the user asks a very small question, but always include evidence and references.",
      "Keep analytical answers around 500-900 words. Keep simple factual answers shorter. Keep scripts ready-to-record.",
      "",
      `Creator evidence: ${JSON.stringify({
        creator: context.creator,
        kpis: context.kpis,
        hookLeader: context.hookLeader,
        pillarLeader: context.pillarLeader,
        topReel: context.topReel,
        hookStats: (dashboard.charts?.hooks || []).slice(0, 2).map((item) => ({
          label: item.label,
          views: item.views,
          avgViews: item.avgViews,
          avgRetention: item.avgRetention,
          posts: item.posts
        })),
        pillarStats: (dashboard.charts?.pillars || []).slice(0, 2).map((item) => ({
          label: item.label,
          views: item.views,
          posts: item.posts
        })),
        transcriptContext,
        creatorReels,
        topCompetitor: dashboard.competitors?.[0] ? {
          name: dashboard.competitors[0].name,
          monthlyGrowthLabel: dashboard.competitors[0].monthlyGrowthLabel,
          engagementRateLabel: dashboard.competitors[0].engagementRateLabel,
          bestFormat: dashboard.competitors[0].bestFormat,
          topHook: dashboard.competitors[0].topHook
        } : null,
        competitorReels
      })}`,
      `Current dashboard range: ${JSON.stringify(dashboard.filters || {})}`,
      `Transcript evidence sample count: ${String(transcriptContext.length)}`,
      `Selected story context: ${JSON.stringify(selectedStory || null)}`,
      `Previous user context: ${JSON.stringify(previousUser || "")}`,
      `Previous assistant context: ${JSON.stringify(previousAssistant || "")}`,
      "",
      `User question: ${prompt}`
    ].join("\n")
  });

  return {
    answer: interactionOutputText(result) || "",
    citations: [
      { view: "performance", section: "allPostsTable", label: "Creator transcripts" },
      { view: "performance", section: "hookChart", label: "Hook performance" },
      { view: "competitors", section: "competitorsTable", label: "Competitor references" },
      dashboard.insights[0]?.citation
    ].filter(Boolean)
  };
}

async function geminiContentIdeasChat(prompt, dashboard, history = []) {
  if (!geminiApiKey) return null;
  const context = buildContextSummary(dashboard);
  const transcriptContext = (Array.isArray(context.transcriptContext) ? context.transcriptContext.slice(0, 3) : [])
    .map((reel) => ({
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      strategy: reel.strategy,
      openingLine: compactChatText(reel.openingLine, 90),
      matchedSnippet: compactChatText(reel.matchedSnippet, 130),
      views: reel.views
    }));
  const creatorReels = (dashboard.posts || [])
    .slice()
    .sort((left, right) => reelPerformanceScore(right) - reelPerformanceScore(left))
    .slice(0, 2)
    .map((reel) => ({
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      strategy: reel.strategy,
      views: reel.viewsLabel || fmtCompact(reel.views),
      transcriptOpening: compactChatText(normalizeTimestampedTranscript(reel.timestampedTranscript)[0]?.text || reel.scriptSummary?.[0] || "", 80),
      transcriptSnippet: compactChatText(reel.transcript || reel.caption || "", 80)
    }));
  const competitorReels = (dashboard.competitorReels || [])
    .filter((reel) => hasTranscriptPayload(reel))
    .slice()
    .sort((left, right) => reelPerformanceScore(right) - reelPerformanceScore(left))
    .slice(0, 1)
    .map((reel) => ({
      creator: reel.sourceName || reel.sourceHandle,
      title: reel.title,
      hook: reel.hook,
      pillar: reel.pillar,
      strategy: reel.strategy,
      views: fmtCompact(reel.views),
      transcriptOpening: compactChatText(normalizeTimestampedTranscript(reel.timestampedTranscript)[0]?.text || reel.scriptSummary?.[0] || "", 80),
      transcriptSnippet: compactChatText(reel.transcript || reel.caption || "", 80)
    }));
  const result = await geminiTextInteraction({
    prompt: [
      "You are CreatorOS, generating content ideas from a creator's own analytics.",
      "Use the current dashboard range only. The transcript evidence already reflects the selected range and filters; do not pull in older evidence outside it.",
      "The user wants content ideas based on current hooks, pillars, strategy tags, saved transcripts, and competitor references.",
      "Return ideas, not a long lecture before the ideas.",
      "Every idea must be grounded in at least one provided creator or competitor reference from the current range.",
      "Do not invent revenue, views, percentages, names, or claims unless those numbers are present in the provided evidence.",
      "If an idea needs a number but evidence does not provide one, phrase it without a fake number.",
      "Prioritize the creator's winning transcript patterns first, then hook/pillar performance, then competitor patterns second.",
      "Keep the ideas aligned to the same creator niche and language as the strongest transcript examples.",
      "Use Hinglish-friendly concise English.",
      "Format exactly:",
      "1. Quick Read",
      "2. 20 Ideas",
      "3. Top 3 To Film First",
      "4. Confidence",
      "In 20 Ideas, each item must use this compact format: Idea title | Hook type | Pillar | Why it fits | Reference used.",
      "For Quick Read, state the current winning pattern in one paragraph. For Top 3 To Film First, give one sentence per pick with the strongest reference used.",
      "Do not include scene-by-scene execution unless the user asks for script/execution.",
      "",
      `Evidence: ${JSON.stringify({
        hookLeader: context.hookLeader,
        pillarLeader: context.pillarLeader,
        hookStats: (dashboard.charts?.hooks || []).slice(0, 2).map((item) => ({
          label: item.label,
          views: item.views,
          avgViews: item.avgViews,
          avgRetention: item.avgRetention,
          posts: item.posts
        })),
        pillarStats: (dashboard.charts?.pillars || []).slice(0, 2).map((item) => ({
          label: item.label,
          views: item.views,
          posts: item.posts
        })),
        transcriptContext,
        creatorReels,
        topCompetitor: dashboard.competitors?.[0] ? {
          name: dashboard.competitors[0].name,
          monthlyGrowthLabel: dashboard.competitors[0].monthlyGrowthLabel,
          engagementRateLabel: dashboard.competitors[0].engagementRateLabel,
          bestFormat: dashboard.competitors[0].bestFormat,
          topHook: dashboard.competitors[0].topHook
        } : null,
        competitorReels
      })}`,
      `Current dashboard range: ${JSON.stringify(dashboard.filters || {})}`,
      `Transcript evidence sample count: ${String(transcriptContext.length)}`,
      `Previous user context: ${JSON.stringify(previousHistoryMessage(history, "user", prompt) || "")}`,
      "",
      `User ask: ${prompt}`
    ].join("\n")
  });

  return {
    answer: interactionOutputText(result) || "",
    citations: [
      { view: "performance", section: "allPostsTable", label: "Creator transcripts" },
      { view: "performance", section: "hookChart", label: "Hook performance" },
      { view: "competitors", section: "competitorsTable", label: "Competitor references" }
    ]
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

  const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey
    },
    body: JSON.stringify({
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
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
        }
      },
      contents: [{
        role: "user",
        parts: [
        {
          inlineData: {
            mimeType: contentType,
            data: mediaBuffer.toString("base64")
          }
        },
        {
          text: [
            "Generate a transcript of this reel.",
            "Return JSON only.",
            "Include:",
            "1. transcript: full plain-text transcript",
            "2. language: primary spoken language code if possible",
            "3. segments: up to 12 timestamped segments with timestamp and content"
          ].join("\n")
        }
      ]}]
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
    hook: canonicalizeHook(sanitizeShortLabel(payload.hook, reel.hook || "Question Hook", 72), reel.hook || "Question Hook"),
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
  const thumbnailCandidates = [
    "thumbnailUrl",
    "thumbnail_url",
    "displayUrl",
    "display_url",
    "coverUrl",
    "cover_url",
    "imageUrl",
    "image_url",
    "videoThumbnailUrl",
    "video_thumbnail_url",
    "thumbnailSrc",
    "thumbnail_src",
    "display_resources.0.src",
    "display_resources.1.src",
    "display_resources.2.src",
    "image_versions2.candidates.0.url",
    "image_versions2.candidates.1.url",
    "thumbnail_resources.0.src",
    "thumbnail_resources.1.src",
    "thumbnail_resources.2.src",
    "clipsMetadata.thumbnailUrl",
    "clips_metadata.thumbnail_url",
    "clipsMetadata.thumbnail_url"
  ];
  return normalizeReel({
    id: pickValue(item, ["id", "postId", "shortCode", "url", "inputUrl"], `reel-${Math.random().toString(36).slice(2, 8)}`),
    title: deriveReelTitle(item),
    platform: normalizePlatform(pickValue(item, ["platform", "sourcePlatform", "owner.platform"], "instagram")),
    pillar: normalizePillarLabel(pickValue(item, ["pillar", "category", "contentPillar", "analysis.pillar"], "General"), "General"),
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
    thumbnailUrl: pickValue(item, thumbnailCandidates, ""),
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
    pillar: normalizePillarLabel(pickValue(item, ["pillar", "category", "topic"], "General"), "General"),
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
    thumbnailUrl: pickValue(item, [
      "thumbnail_url",
      "display_url",
      "image_url",
      "videoThumbnailUrl",
      "video_thumbnail_url",
      "display_resources.0.src",
      "display_resources.1.src",
      "thumbnail_resources.0.src"
    ], ""),
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
  const nextReels = mapped.reels ? mergeReelsByIdentity(store.reels || [], mapped.reels) : null;
  const nextMergedReels = finalReels ? mergeReelsByIdentity(store.reels || [], finalReels) : null;
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
  await prewarmThumbnailCache(finalReels || mapped.reels || [], 4);
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
    reels: mergeReelsByIdentity(store.reels || [], reels),
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
    byId.set(String(reel.id), mergeReelRecords(current, incomingReel));
  });
  return [...byId.values()];
}

function mergeReelsByIdentity(existing, incoming) {
  const merged = (existing || []).map(normalizeReel);
  const keyToIndex = new Map();

  merged.forEach((reel, index) => {
    reelIdentityKeys(reel).forEach((key) => {
      if (!keyToIndex.has(key)) keyToIndex.set(key, index);
    });
  });

  (incoming || []).forEach((reel) => {
    const incomingReel = normalizeReel(reel);
    const matchKey = reelIdentityKeys(incomingReel).find((key) => keyToIndex.has(key));
    if (matchKey === undefined) {
      const nextIndex = merged.push(incomingReel) - 1;
      reelIdentityKeys(incomingReel).forEach((key) => {
        if (!keyToIndex.has(key)) keyToIndex.set(key, nextIndex);
      });
      return;
    }

    const index = keyToIndex.get(matchKey);
    merged[index] = mergeReelRecords(merged[index], incomingReel);
    reelIdentityKeys(merged[index]).forEach((key) => {
      keyToIndex.set(key, index);
    });
  });

  return merged;
}

function daysSinceIso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return Number.POSITIVE_INFINITY;
  return (Date.now() - parsed.getTime()) / (24 * 60 * 60 * 1000);
}

function metadataRefreshCandidates(store, handle, intervalDays = 7, limit = 3) {
  const cleanHandle = String(handle || "").replace(/^@/, "").trim().toLowerCase();
  if (!cleanHandle) return [];

  return (store.reels || [])
    .map(normalizeReel)
    .filter((reel) => String(reel.sourceHandle || "").trim().toLowerCase() === cleanHandle)
    .filter((reel) => Boolean(String(reel.url || "").trim()))
    .filter((reel) => hasTranscriptPayload(reel))
    .filter((reel) => daysSinceIso(reel.postedAt) >= intervalDays)
    .filter((reel) => daysSinceIso(reel.lastMetadataRefreshAt || reel.analysisUpdatedAt || reel.postedAt) >= intervalDays)
    .sort((left, right) => {
      const leftRefresh = daysSinceIso(left.lastMetadataRefreshAt || left.analysisUpdatedAt || left.postedAt);
      const rightRefresh = daysSinceIso(right.lastMetadataRefreshAt || right.analysisUpdatedAt || right.postedAt);
      return rightRefresh - leftRefresh;
    })
    .slice(0, Math.max(1, Number(limit || 3)));
}

async function stampReelMetadataRefresh(reelIds = [], status = "") {
  if (!reelIds.length) return null;
  const current = await readStore();
  const refreshedAt = new Date().toISOString();
  const idSet = new Set(reelIds.map((id) => String(id)));
  const next = sanitizeStorePatch({
    reels: (current.reels || []).map((reel) => {
      const normalized = normalizeReel(reel);
      if (!idSet.has(normalized.id)) return normalized;
      return normalizeReel({
        ...normalized,
        lastMetadataRefreshAt: refreshedAt
      });
    }),
    integrations: {
      apify: {
        ...apifyConfig(current),
        lastMetadataRefreshAt: refreshedAt,
        lastMetadataRefreshStatus: status || `Refreshed metadata for ${reelIds.length} reels`
      }
    }
  }, current);
  await writeStore(next);
  return next;
}

async function runApifyMetadataRefreshCycle(store, config, username) {
  if (!config.metadataRefreshEnabled) return null;
  const intervalDays = Math.max(1, Number(config.metadataRefreshIntervalDays || 7));
  const batchSize = Math.max(1, Number(config.metadataRefreshBatchSize || 3));
  const candidates = metadataRefreshCandidates(store, username, intervalDays, batchSize);
  if (!candidates.length) return null;

  const result = await runApifyImport(store, {
    mode: config.mode,
    actorId: config.actorId,
    taskId: config.taskId,
    strategy: "reels",
    input: {
      ...(config.input || {}),
      username: [config.autoImportUsername || config.input?.username || "abvaidya"].flat().filter(Boolean),
      directUrls: candidates.map((reel) => reel.url).filter(Boolean),
      resultsLimit: candidates.length,
      includeTranscript: false,
      includeDownloadedVideo: false,
      skipPinnedPosts: true
    }
  });

  await stampReelMetadataRefresh(
    candidates.map((reel) => reel.id),
    `Refreshed metadata for ${candidates.length} analyzed reels @${username}`
  );

  return {
    ...result,
    refreshed: candidates.length
  };
}

function thumbnailBackfillCandidates(store, limit = 12, handle = "") {
  const normalizedHandle = String(handle || inferPrimaryCreatorHandle(store) || store.creator?.handle || "abvaidya").replace(/^@/, "").trim().toLowerCase();
  return (store.reels || [])
    .map(normalizeReel)
    .filter((reel) => {
      if (!normalizedHandle) return true;
      return String(reel.sourceHandle || "").trim().toLowerCase() === normalizedHandle;
    })
    .filter((reel) => hasTranscriptPayload(reel))
    .filter((reel) => Boolean(String(reel.url || "").trim()))
    .sort((left, right) => Number(right.views || 0) - Number(left.views || 0))
    .slice(0, Math.max(1, Math.min(25, Number(limit || 12))));
}

async function runApifyThumbnailBackfill(store, options = {}) {
  const config = apifyConfig(store);
  if (!config.token || !config.actorId) {
    throw new Error("Apify auto import is not configured.");
  }

  const creatorHandle = String(store.creator?.handle || inferPrimaryCreatorHandle(store) || config.autoImportUsername || "abvaidya").replace(/^@/, "").trim().toLowerCase();
  const candidates = thumbnailBackfillCandidates(store, options.limit || 12, creatorHandle);
  if (!candidates.length) {
    return { store, backfilled: 0, candidateIds: [] };
  }

  const result = await runApifyImport(store, {
    mode: config.mode,
    actorId: config.actorId,
    taskId: config.taskId,
    strategy: "reels",
    input: {
      ...(config.input || {}),
      username: [creatorHandle || config.autoImportUsername || config.input?.username || "abvaidya"].flat().filter(Boolean),
      directUrls: candidates.map((reel) => reel.url).filter(Boolean),
      resultsLimit: candidates.length,
      includeTranscript: false,
      includeDownloadedVideo: false,
      skipPinnedPosts: true
    }
  });

  await stampReelMetadataRefresh(
    candidates.map((reel) => reel.id),
    `Backfilled thumbnails for ${candidates.length} analyzed reels`
  );

  return {
    ...result,
    backfilled: candidates.length,
    candidateIds: candidates.map((reel) => reel.id)
  };
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

    let metadataStatus = "";
    try {
      const refreshed = await runApifyMetadataRefreshCycle(await readStore(), config, username);
      if (refreshed?.refreshed) {
        metadataStatus = ` + refreshed ${refreshed.refreshed} analyzed reels`;
      }
    } catch (error) {
      metadataStatus = ` | metadata refresh failed: ${error.message}`;
    }

    const current = await readStore();
    const next = sanitizeStorePatch({
      integrations: {
        apify: {
          ...apifyConfig(current),
          lastAutoImportAt: new Date().toISOString(),
          lastAutoImportStatus: `Imported ${result.importedCounts.reels} reels for @${username}${metadataStatus}`
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
  const next = sanitizeStorePatch({
    ...normalizedImport,
    reels: Array.isArray(normalizedImport.reels)
      ? mergeReelsByIdentity(current.reels || [], normalizedImport.reels)
      : normalizedImport.reels
  }, current);
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
      const query = Object.fromEntries(url.searchParams.entries());
      const dashboard = await decorateDashboard(store, computeDashboard(store, query));
      return replyJson(response, 200, query.compact === "1" ? compactDashboard(dashboard) : dashboard);
    }

    if (url.pathname === "/api/competitor-reel" && request.method === "GET") {
      const id = String(url.searchParams.get("id") || "");
      const store = await readStore();
      const reel = (store.competitorReels || []).map(normalizeReel).find((item) => item.id === id);
      if (!reel) return replyJson(response, 404, { error: "Competitor reel not found." });
      return replyJson(response, 200, { reel });
    }

    if (url.pathname === "/api/reel-thumbnail" && (request.method === "GET" || request.method === "HEAD")) {
      const id = String(url.searchParams.get("id") || "");
      const requestedSource = String(url.searchParams.get("src") || "");
      const fallbackTitle = String(url.searchParams.get("title") || "");
      const fallbackHandle = String(url.searchParams.get("handle") || "");
      const store = await readStore();
      const reel = [...(store.reels || []), ...(store.competitorReels || [])]
        .map(normalizeReel)
        .find((item) => item.id === id);
      const fallbackReel = reel || {
        title: fallbackTitle,
        caption: fallbackTitle,
        sourceHandle: fallbackHandle
      };
      const thumbnailUrl = String(reel?.thumbnailUrl || requestedSource || "");
      const postUrl = String(reel?.url || reel?.postUrl || "");
      const cachePath = thumbnailCachePath(id || thumbnailUrl);
      const cached = await readFile(cachePath).catch(() => null);
      if (cached) {
        response.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=86400"
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        response.end(cached);
        return;
      }
      if (!thumbnailUrl || !/^https:\/\/(?:[^/]+\.)*(?:instagram\.com|cdninstagram\.com|fbcdn\.net)\//i.test(thumbnailUrl)) {
        response.writeHead(200, {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=3600"
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        response.end(thumbnailFallbackSvg(fallbackReel));
        return;
      }
      let fetched = await fetchRemoteThumbnailBuffer(thumbnailUrl);
      let refreshedThumbnailUrl = "";
      if (!fetched?.buffer?.length && postUrl) {
        refreshedThumbnailUrl = await fetchInstagramPageThumbnailUrl(postUrl);
        if (refreshedThumbnailUrl) {
          fetched = await fetchRemoteThumbnailBuffer(refreshedThumbnailUrl);
        }
      }
      if (!fetched?.buffer?.length && refreshedThumbnailUrl) {
        response.writeHead(302, {
          Location: refreshedThumbnailUrl,
          "Cache-Control": "public, max-age=3600"
        });
        response.end();
        return;
      }
      if (!fetched?.buffer?.length) {
        response.writeHead(200, {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=900"
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        response.end(thumbnailFallbackSvg(fallbackReel));
        return;
      }
      await mkdir(thumbnailCacheDir, { recursive: true }).catch(() => {});
      await writeFile(cachePath, fetched.buffer).catch(() => {});
      response.writeHead(200, {
        "Content-Type": fetched.contentType || "image/jpeg",
        "Cache-Control": "public, max-age=86400"
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      response.end(fetched.buffer);
      return;
    }

    if (url.pathname === "/api/chart-series" && request.method === "GET") {
      const dashboard = computeDashboard(await readStore(), Object.fromEntries(url.searchParams.entries()));
      return replyJson(response, 200, dashboard.charts);
    }

    if (url.pathname === "/api/news/import-live" && request.method === "POST") {
      if (isRateLimited(request, "news-refresh", 6, 10 * 60_000)) {
        return replyJson(response, 429, { error: "Too many news refreshes. Try again shortly." });
      }
      const current = await readStore();
      const result = await handleLiveNewsImport({ lookbackDays: 14, perQuery: 15 }, current);
      return replyJson(response, result.status, result.payload);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (isRateLimited(request, "chat", 40, 60_000)) {
        return replyJson(response, 429, { error: "Too many chat requests. Try again shortly." });
      }
      const body = parseJson(await collectBody(request), {});
      const prompt = String(body.prompt || "").trim();
      const history = normalizeChatHistory(body.history);
      const selectedStory = normalizeChatStoryContext(body.storyContext);
      const store = await readStore();
      const dashboard = computeDashboard(store, body.filters || {});
      dashboard.transcriptContext = buildChatTranscriptContext(store, dashboard, prompt, selectedStory);
      const analyticsMeta = chatGroundingMeta(dashboard.transcriptContext, { analyticsOnly: true });
      const transcriptMeta = chatGroundingMeta(dashboard.transcriptContext, { limit: 6 });
      const geminiRequired = isGeminiRequiredChatRequest(prompt);
      if (isContentIdeasRequest(prompt)) {
        let ideasResult = null;
        let ideasError = null;
        try {
          ideasResult = await geminiContentIdeasChat(prompt, dashboard, history);
        } catch (error) {
          ideasError = error;
          ideasResult = null;
        }
        if (ideasResult?.answer) {
          return replyJson(response, 200, {
            ...ideasResult,
            ...transcriptMeta
          });
        }
        if (geminiRequired) {
          return replyJson(response, 503, {
            answer: geminiUnavailableAnswer(ideasError),
            ...transcriptMeta,
            citations: [{ view: "performance", section: "allPostsTable", label: "Creator transcripts" }]
          });
        }
      }
      let unifiedResult = null;
      let unifiedError = null;
      try {
        unifiedResult = await geminiUnifiedChat(prompt, dashboard, history, selectedStory);
      } catch (error) {
        unifiedError = error;
        unifiedResult = null;
      }
      if (unifiedResult?.answer) {
        return replyJson(response, 200, {
          ...unifiedResult,
          ...transcriptMeta
        });
      }
      if (geminiRequired) {
        return replyJson(response, 503, {
          answer: geminiUnavailableAnswer(unifiedError),
          ...transcriptMeta,
          citations: [{ view: "performance", section: "allPostsTable", label: "Creator transcripts" }]
        });
      }
      if (isFullScriptRequest(prompt)) {
        let scriptResult = null;
        try {
          scriptResult = await geminiFullScriptChat(prompt, dashboard, history);
        } catch {
          scriptResult = null;
        }
        return replyJson(response, 200, {
          ...(scriptResult && scriptResult.answer
            ? scriptResult
            : {
                answer: chatFullScriptAnswer(prompt, dashboard, dashboard.transcriptContext, history),
                citations: [
                  { view: "performance", section: "allPostsTable", label: "Transcript examples" },
                  dashboard.insights[0]?.citation
                ].filter(Boolean)
              }),
          ...transcriptMeta
        });
      }
      if (shouldForceTranscriptRead(prompt, dashboard)) {
        let transcriptResult = null;
        try {
          transcriptResult = await geminiTranscriptStrategyChat(prompt, dashboard);
        } catch {
          transcriptResult = null;
        }
        return replyJson(response, 200, {
          ...(transcriptResult || {
            answer: transcriptStrategyFallbackAnswer(prompt, dashboard, dashboard.transcriptContext),
            citations: [{ view: "performance", section: "allPostsTable", label: "Transcript examples" }]
          }),
          ...transcriptMeta
        });
      }
      if (isMonthlySummaryRequest(prompt)) {
        return replyJson(response, 200, {
          answer: chatMonthlySummaryAnswer(dashboard),
          ...analyticsMeta,
          citations: [
            { view: "performance", section: "kpiGrid", label: "Dashboard KPIs" },
            dashboard.insights[0]?.citation,
            dashboard.insights[2]?.citation
          ].filter(Boolean)
        });
      }
      if (isWeeklyPlanRequest(prompt)) {
        return replyJson(response, 200, {
          answer: chatWeeklyPlanAnswer(dashboard, dashboard.transcriptContext),
          ...chatGroundingMeta(dashboard.transcriptContext, { limit: 4 }),
          citations: [
            { view: "performance", section: "allPostsTable", label: "Transcript examples" },
            dashboard.insights[3]?.citation
          ].filter(Boolean)
        });
      }
      if (isNextPostRequest(prompt)) {
        let nextPostResult = null;
        try {
          nextPostResult = await geminiNextPostChat(prompt, dashboard, history);
        } catch {
          nextPostResult = null;
        }
        return replyJson(response, 200, {
          ...(nextPostResult && nextPostResult.answer
            ? nextPostResult
            : {
                answer: chatNextPostAnswer(dashboard, dashboard.transcriptContext),
                citations: [
                  { view: "performance", section: "allPostsTable", label: "Transcript examples" },
                  dashboard.insights[0]?.citation,
                  dashboard.insights[3]?.citation
                ].filter(Boolean)
              }),
          ...chatGroundingMeta(dashboard.transcriptContext, { limit: 4 })
        });
      }
      if (isCompetitorMomentumRequest(prompt, dashboard)) {
        return replyJson(response, 200, {
          answer: chatCompetitorMomentumAnswer(prompt, dashboard),
          ...analyticsMeta,
          citations: [{ view: "competitors", section: "competitorsTable", label: "Competitor tracker" }]
        });
      }
      if (isAllReelsAnalysisRequest(prompt)) {
        return replyJson(response, 200, {
          answer: chatAllReelsAnalysisAnswer(dashboard),
          ...analyticsMeta,
          citations: [
            { view: "performance", section: "kpiGrid", label: "Dashboard KPIs" },
            dashboard.insights[0]?.citation
          ].filter(Boolean)
        });
      }
      if (isAllScriptsAnalysisRequest(prompt)) {
        return replyJson(response, 200, {
          answer: chatAllScriptsAuditAnswer(dashboard),
          ...transcriptMeta,
          citations: [
            { view: "performance", section: "allPostsTable", label: "Creator transcripts" },
            { view: "performance", section: "hookChart", label: "Hook performance" }
          ]
        });
      }
      if (isOutshineStrategyRequest(prompt)) {
        return replyJson(response, 200, {
          answer: chatOutshineStrategyAnswer(dashboard),
          ...transcriptMeta,
          citations: [
            { view: "performance", section: "allPostsTable", label: "Creator transcripts" },
            { view: "competitors", section: "competitorsTable", label: "Competitor references" }
          ]
        });
      }
      if (isBestReelAnalysisRequest(prompt)) {
        return replyJson(response, 200, {
          answer: chatBestReelAnalysisAnswer(dashboard),
          ...analyticsMeta,
          citations: [
            { view: "performance", section: "topPerformers", label: "Top performers" },
            { view: "performance", section: "allPostsTable", label: "Reel-level breakdown" }
          ]
        });
      }
      if (isTranscriptStrategyRequest(prompt)) {
        let transcriptResult = null;
        try {
          transcriptResult = await geminiTranscriptStrategyChat(prompt, dashboard);
        } catch {
          transcriptResult = null;
        }
        return replyJson(response, 200, {
          ...(transcriptResult || {
            answer: transcriptStrategyFallbackAnswer(prompt, dashboard, dashboard.transcriptContext),
            citations: [{ view: "performance", section: "allPostsTable", label: "Transcript examples" }]
          }),
          ...transcriptMeta
        });
      }
      if (isNewsScriptRequest(prompt, selectedStory) || isNewsScriptFollowUp(prompt, selectedStory)) {
        return replyJson(response, 200, {
          answer: chatNewsAnswer(selectedStory, dashboard.news?.[0]?.headline, selectedHookIndex(prompt), dashboard.transcriptContext),
          ...chatGroundingMeta(dashboard.transcriptContext, { limit: 4 }),
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
      return replyJson(response, 200, {
        ...(result || fallbackChat(prompt, dashboard, selectedStory)),
        ...analyticsMeta
      });
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

    if (url.pathname === "/api/admin/reels/backfill-thumbnails" && request.method === "POST") {
      if (!requireAdmin(request, response)) return;
      const body = parseJson(await collectBody(request), {});
      const current = await readStore();
      const result = await runApifyThumbnailBackfill(current, { limit: body.limit });
      const latest = await readStore();
      return replyJson(response, 200, {
        ok: true,
        backfilled: result.backfilled || 0,
        candidateIds: result.candidateIds || [],
        store: publicStore(latest)
      });
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
