const state = {
  activeView: "performance",
  dashboard: null,
  store: null,
  aiMode: "Rule-based fallback",
  loadingDashboard: false,
  rangeMode: "preset",
  filters: {
    range: "365",
    pillar: "all",
    hook: "all",
    platform: "all",
  },
  messages: [],
  threads: [],
  currentThreadId: "",
  pinnedMessages: [],
  postExplorer: {
    search: "",
    sort: "postedAt",
    pillar: "all",
    hook: "all",
    format: "all",
    platform: "all",
  },
  activePostId: "",
  activeCompetitorHandle: "",
  activeCompetitorPostId: "",
  modalReturnTarget: null,
  modalReturnFocus: null,
  competitorCompareHandle: "",
  newsCategory: "All",
  modalScrollPosition: { x: 0, y: 0 },
  userRole: "",
};

const navItems = [
  { id: "performance", label: "Content Performance", icon: "⌁" },
  { id: "competitors", label: "Competitor Intel", icon: "↔" },
  { id: "assistant", label: "AI Copilot", icon: "AI" },
  { id: "news", label: "News Radar", icon: "◎" },
  { id: "admin", label: "Admin", icon: "⋯" },
];

const viewChrome = {
  performance: {
    topbarEyebrow: "Content performance",
    topbarTitle: "Every reel, decoded.",
    heroEyebrow: "Content performance · Instagram reels",
    prototype: "Live imported analytics",
  },
  competitors: {
    topbarEyebrow: "Competitor intelligence",
    topbarTitle: "Know the niche cold.",
    heroEyebrow: "Competitor intelligence",
    prototype: "Imported watchlist",
  },
  news: {
    topbarEyebrow: "News radar",
    topbarTitle: "The niche, as it happens.",
    heroEyebrow: "News radar · auto-curated for your beat",
    prototype: "Live niche-matched feed",
  },
  assistant: {
    topbarEyebrow: "AI content assistant",
    topbarTitle: "Grounded analytics copilot.",
    heroEyebrow: "AI content assistant",
    prototype: "Prototype · simulated data",
  },
  admin: {
    topbarEyebrow: "Admin",
    topbarTitle: "Control the live store.",
    heroEyebrow: "Admin controls",
    prototype: "Config + imports",
  },
};

const $ = (selector) => document.querySelector(selector);
const adminTokenStorageKey = "creator-os-admin-token";
const authRoleStorageKey = "creator-os-role";
const viewerAccessCode = "123456";
const adminAccessCode = "654321";
const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function parseJsonSafe(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function creatorInitials() {
  const name = String(state.dashboard?.creator?.name || state.store?.creator?.name || "Creator OS").trim();
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((token) => token[0]?.toUpperCase() || "")
    .join("") || "CO";
}

function readAdminToken() {
  return $("#adminToken").value.trim();
}

function persistAdminToken() {
  const token = readAdminToken();
  if (!token) {
    window.localStorage.removeItem(adminTokenStorageKey);
    return "";
  }
  window.localStorage.setItem(adminTokenStorageKey, token);
  return token;
}

function requireAdminToken(statusTarget = "#adminStatus") {
  const token = persistAdminToken();
  if (token) return token;
  const target = $(statusTarget);
  if (target) target.textContent = "Enter admin token first in the Admin tab.";
  throw new Error("Enter admin token first in the Admin tab.");
}

function syncImportSourceFields() {
  const source = $("#importSource").value;
  const isBrightData = source === "brightdata";
  $("#apifyInput").placeholder = isBrightData
    ? '[{"url":"https://www.instagram.com/abvaidya/"}]'
    : '{"directUrls":["https://www.instagram.com/reel/ABC123/"],"resultsLimit":10}';
  const savedInput = isBrightData
    ? state.store?.integrations?.brightData?.input || []
    : state.store?.integrations?.apify?.input || {};
  $("#apifyInput").value = JSON.stringify(savedInput, null, 2);
}

function highlightHeadline(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value.includes(",")) {
    const parts = value.split(",");
    const first = parts.shift();
    return `${escapeHtml(first)}, <span>${escapeHtml(parts.join(",").trim())}</span>`;
  }
  const words = value.split(/\s+/);
  if (words.length < 2) return escapeHtml(value);
  const lead = words.slice(0, -1).join(" ");
  const accent = words[words.length - 1];
  return `${escapeHtml(lead)} <span>${escapeHtml(accent)}</span>`;
}

function renderChrome() {
  const chrome = viewChrome[state.activeView] || viewChrome.performance;
  document.body.dataset.view = state.activeView;
  $("#topbarEyebrow").textContent = chrome.topbarEyebrow;
  $("#topbarTitle").textContent = chrome.topbarTitle;
  $("#heroEyebrow").textContent = chrome.heroEyebrow;
  $("#prototypeBadge").textContent = chrome.prototype;
}

function defaultAssistantMessage() {
  return {
    role: "assistant",
    text: "Hey Arjun. I'm plugged into all 119 reels, your competitor tracker, and 210 days of trends. Ask me anything or start with a quick action above.",
    citations: [],
    tone: "ready",
  };
}

function conversationTitleFromPrompt(prompt) {
  return String(prompt || "New chat")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 52) || "New chat";
}

function threadPreview(thread) {
  const lastUser = [...thread.messages].reverse().find((message) => message.role === "user");
  return conversationTitleFromPrompt(lastUser?.text || thread.title);
}

function createThread(title = "New chat") {
  return {
    id: `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    updatedAt: new Date().toISOString(),
    messages: [defaultAssistantMessage()],
    storyContext: null,
  };
}

function currentThread() {
  return state.threads.find((item) => item.id === state.currentThreadId) || null;
}

async function persistAssistantState() {
  await fetch("/api/assistant/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threads: state.threads,
      pinned: state.pinnedMessages,
    }),
  });
}

async function syncCurrentThread() {
  const thread = currentThread();
  if (!thread) return;
  thread.messages = state.messages.map((message) => ({ ...message }));
  thread.updatedAt = new Date().toISOString();
  const firstUser = thread.messages.find((message) => message.role === "user");
  thread.title = conversationTitleFromPrompt(firstUser?.text || thread.title);
  state.threads.sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  await persistAssistantState();
}

async function restoreAssistantState() {
  const response = await fetch("/api/assistant/state");
  const saved = response.ok ? await response.json() : {};
  const savedThreads = Array.isArray(saved.threads) ? saved.threads : [];
  const savedPins = Array.isArray(saved.pinned) ? saved.pinned : [];
  state.pinnedMessages = savedPins;
  if (savedThreads.length) {
    state.threads = savedThreads;
    state.currentThreadId = savedThreads[0].id;
    state.messages = savedThreads[0].messages?.length ? savedThreads[0].messages : [defaultAssistantMessage()];
    return;
  }
  const freshThread = createThread();
  state.threads = [freshThread];
  state.currentThreadId = freshThread.id;
  state.messages = freshThread.messages.map((message) => ({ ...message }));
  await persistAssistantState();
}

function queryString() {
  const params = Object.fromEntries(
    Object.entries(state.filters).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return new URLSearchParams(params).toString();
}

function isAdminUser() {
  return state.userRole === "admin";
}

function renderNav() {
  const visibleNavItems = navItems.filter((item) => item.id !== "admin" || isAdminUser());
  $("#nav").innerHTML = visibleNavItems
    .map(
      (item) => `<button class="nav-item ${state.activeView === item.id ? "active" : ""}" data-view="${item.id}"><span class="nav-icon">${item.icon}</span><span>${item.label}</span></button>`,
    )
    .join("");
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.onclick = () => {
      openView(button.dataset.view);
    };
  });
}

function openView(viewId, options = {}) {
  if (viewId === "admin" && !isAdminUser()) {
    viewId = "performance";
  }
  const skipPageScroll = Boolean(options.skipPageScroll);
  state.activeView = viewId;
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === viewId);
  });
  document.body.dataset.view = viewId;
  renderChrome();
  renderNav();
  const content = document.querySelector(".content");
  if (!skipPageScroll) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (content) content.scrollTo({ top: 0, behavior: "smooth" });
  }
  if (viewId === "assistant") {
    requestAnimationFrame(() => {
      $("#messages")?.scrollTo({ top: $("#messages").scrollHeight, behavior: "smooth" });
      $("#chatInput")?.focus();
    });
  }
}

function jumpToAssistantChat({ freshThread = false } = {}) {
  if (freshThread) {
    startNewChat();
  }
  openView("assistant", { skipPageScroll: true });
  requestAnimationFrame(() => {
    $("#messages")?.scrollTo({ top: $("#messages").scrollHeight, behavior: "smooth" });
    $("#chatInput")?.focus();
  });
}

function renderFilters() {
  const { filterOptions, filters } = state.dashboard;
  $("#rangeFilter").value = filters.range;
  fillSelect("#pillarFilter", filterOptions.pillars, filters.pillar);
  fillSelect("#hookFilter", filterOptions.hooks, filters.hook);
  fillSelect("#platformFilter", filterOptions.platforms, filters.platform);
  syncRangeToolbar();
}

function syncRangeToolbar() {
  const activeRange = String(state.filters.range || state.dashboard?.filters?.range || "365");
  const isCustom = state.rangeMode === "custom" || Boolean(state.filters.from || state.filters.to);
  document.querySelectorAll("[data-range-segment]").forEach((button) => {
    const selected = isCustom
      ? button.dataset.rangeSegment === "custom"
      : button.dataset.rangeSegment === activeRange;
    button.classList.toggle("active", selected);
  });
  $("#customRangeStart").value = state.filters.from || "";
  $("#customRangeEnd").value = state.filters.to || "";
}

function formatDateInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function setPresetRange(range) {
  state.rangeMode = "preset";
  state.filters.range = String(range);
  delete state.filters.from;
  delete state.filters.to;
  syncRangeToolbar();
  return fetchDashboard();
}

function applyCustomRange() {
  const start = $("#customRangeStart").value;
  const end = $("#customRangeEnd").value;
  if (!start || !end) return;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return;
  if (startDate > endDate) {
    [state.filters.from, state.filters.to] = [end, start];
  } else {
    state.filters.from = start;
    state.filters.to = end;
  }
  const fromDate = new Date(state.filters.from);
  const toDate = new Date(state.filters.to);
  const rangeDays = Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1);
  state.rangeMode = "custom";
  state.filters.range = String(rangeDays);
  syncRangeToolbar();
  return fetchDashboard();
}

function fillSelect(selector, values, active) {
  $(selector).innerHTML = values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(labelize(value))}</option>`)
    .join("");
  $(selector).value = active;
}

function labelize(value) {
  if (value === "all") return "All";
  return value.replaceAll("_", " ");
}

function fillExplorerSelect(selector, values, active, fallbackLabel) {
  const normalized = ["all", ...new Set(values.filter(Boolean))];
  $(selector).innerHTML = normalized
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value === "all" ? fallbackLabel : labelize(value))}</option>`)
    .join("");
  $(selector).value = active;
}

function postDisplayTitle(post, fallback = "Reel breakdown") {
  const title = String(post?.title || "").trim();
  if (title && !/^imported reel$/i.test(title)) return title;
  return shortText(post?.caption || post?.transcript || post?.hook || fallback, fallback, 86);
}

function initialsForPost(post) {
  return postDisplayTitle(post, "Reel")
    .split(/\s+/)
    .slice(0, 2)
    .map((token) => token[0]?.toUpperCase() || "")
    .join("") || "RE";
}

function deriveTone(post) {
  if (/story/i.test(post.hook)) return "Warm story";
  if (/question/i.test(post.hook)) return "Curious";
  if (/bold/i.test(post.hook)) return "Opinionated";
  if (/framework/i.test(post.hook)) return "Structured";
  return "Direct";
}

function deriveAudio(post) {
  if (/news/i.test(post.format)) return "Voiceover";
  if (/narrative|story/i.test(post.format)) return "Original voice";
  if (/talking|direct/i.test(post.format)) return "Direct-to-camera";
  return "Trend bed";
}

function deriveProduction(post) {
  if (/whiteboard|slide/i.test(post.format)) return "Low production";
  if (/news|commentary/i.test(post.format)) return "Editorial cut";
  if (/narrative/i.test(post.format)) return "Cinematic solo";
  return "Creator-native";
}

function shortText(value, fallback = "", limit = 180) {
  const text = String(value || fallback || "").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (!number) return "0";
  if (number >= 1_000_000) {
    const millions = number / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (number >= 100_000) return `${(number / 1000).toFixed(0)}K`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return number.toLocaleString("en-IN");
}

function parseCompactNumber(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return 0;
  const number = Number(text.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(number)) return 0;
  if (text.endsWith("M")) return number * 1_000_000;
  if (text.endsWith("K")) return number * 1_000;
  return number;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function metricHasSignal(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return false;
  if (["0", "0%", "+0", "+0%", "-0%", "#- / -", "none", "unknown", "n/a"].includes(text)) return false;
  const number = Number(text.replace(/[^\d.-]/g, ""));
  if (Number.isFinite(number) && number === 0) return false;
  return true;
}

function derivedPerformanceKpis(data) {
  const posts = data.posts || [];
  const totalViews = posts.reduce((sum, post) => sum + Number(post.views || 0), 0);
  const totalLikes = posts.reduce((sum, post) => sum + Number(post.likes || 0), 0);
  const totalComments = posts.reduce((sum, post) => sum + Number(post.comments || 0), 0);
  const totalShares = posts.reduce((sum, post) => sum + Number(post.shares || 0), 0);
  const totalSaves = posts.reduce((sum, post) => sum + Number(post.saves || 0), 0);
  const totalFollowers = posts.reduce((sum, post) => sum + Number(post.followersGained || 0), 0);
  const avgRetention = average(posts.map((post) => post.retention));
  const totalEngagements = totalLikes + totalComments + totalShares + totalSaves;
  const avgEngagement = totalViews > 0 ? (totalEngagements / totalViews) * 100 : 0;
  const viewsMissing = totalViews === 0 && totalEngagements > 0;
  const totalWatchTime = posts.reduce((sum, post) => sum + Number(post.watchTime || 0), 0);

  return [
    { label: "Total views", value: viewsMissing ? "Missing" : compactNumber(totalViews), delta: viewsMissing ? "source did not return views" : data.kpis?.[0]?.delta || "+0%", sparkKey: "views", size: "large", tone: "iris" },
    { label: "Engagement rate", value: viewsMissing ? "N/A" : `${avgEngagement.toFixed(2)}%`, delta: viewsMissing ? "needs views" : "+0%", sparkKey: "retention", size: "large", tone: "violet" },
    { label: "Reach", value: viewsMissing ? "0" : compactNumber(totalLikes + totalComments + totalShares), delta: "-0%", sparkKey: "views", size: "small", tone: "iris" },
    { label: "Watch time", value: `${(totalWatchTime / 3600).toFixed(1)}K hrs`, delta: "-0%", sparkKey: "retention", size: "small", tone: "violet" },
    { label: "Avg watch %", value: `${avgRetention.toFixed(1)}%`, delta: "-0%", sparkKey: "retention", size: "mini", tone: "iris" },
    { label: "Likes", value: compactNumber(totalLikes), delta: "+0%", sparkKey: "views", size: "mini", tone: "violet" },
    { label: "Comments", value: compactNumber(totalComments), delta: "+0%", sparkKey: "views", size: "mini", tone: "iris" },
    { label: "Shares", value: compactNumber(totalShares), delta: "+0%", sparkKey: "views", size: "mini", tone: "violet" },
    { label: "Saves", value: compactNumber(totalSaves), delta: "+0%", sparkKey: "views", size: "mini", tone: "iris" },
    { label: "Followers gained", value: `+${compactNumber(totalFollowers)}`, delta: "+0%", sparkKey: "followers", size: "mini", tone: "violet" },
  ].filter((item) => item.label === "Total views" || item.label === "Engagement rate" || metricHasSignal(item.value));
}

function buildSceneTimeline(post) {
  const timestampedTranscript = normalizeTimestampedTranscript(post.timestampedTranscript);
  if (timestampedTranscript.length) {
    return timestampedTranscript;
  }
  if (Array.isArray(post.sceneBreakdown) && post.sceneBreakdown.length) {
    return post.sceneBreakdown;
  }
  if (String(post.transcript || "").trim()) {
    return post.transcript
      .split(/\n+/)
      .map((line, index) => {
        const text = line.trim();
        return text ? { time: `${index + 1}`, text } : null;
      })
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function buildFallbackSceneTimeline(post) {
  const captionLead = shortText(post.caption, postDisplayTitle(post), 220);
  return [
    { time: "0-3s", text: `${post.hook} opener. ${shortText(postDisplayTitle(post), "The reel opens by establishing the core idea.", 140)}` },
    { time: "3-8s", text: captionLead || `${deriveTone(post)} delivery builds the main promise while staying inside ${post.pillar.toLowerCase()}.` },
    { time: "8-15s", text: `${post.format} pacing carries the middle section, with attention anchored by ${post.audioType || deriveAudio(post).toLowerCase()}.` },
    { time: "15-22s", text: `Performance signal so far: ${post.viewsLabel} views, ${post.likesLabel} likes, ${post.commentsLabel} comments.` },
    { time: "22s+", text: post.caption ? "The caption extends the context and pushes the viewer toward the larger idea behind the post." : `Close with a short CTA that nudges saves or follows, matching the ${deriveAudio(post).toLowerCase()} finish.` },
  ];
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
          return { time: `${index + 1}`, text };
        })
        .filter(Boolean);
    }
  }

  return [];
}

function normalizeReel(reel = {}) {
  const timestampedTranscript = normalizeTimestampedTranscript(
    reel.timestampedTranscript || reel.timestamped_transcript || reel.transcriptSegments || reel.segments,
  );
  const sceneBreakdown = Array.isArray(reel.sceneBreakdown)
    ? reel.sceneBreakdown
        .map((scene, index) => ({
          time: String(scene?.time || `${index + 1}`),
          text: String(scene?.text || "").trim(),
        }))
        .filter((scene) => scene.text)
    : timestampedTranscript;
  const scriptSummary = Array.isArray(reel.scriptSummary)
    ? reel.scriptSummary.map((line) => String(line || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const transcript = String(reel.transcript || timestampedTranscript.map((segment) => segment.text).join("\n") || "");
  return {
    ...reel,
    id: String(reel.id || reel.shortCode || `reel-${Math.random().toString(36).slice(2, 8)}`),
    title: String(reel.title || reel.captionHeadline || reel.caption || "Untitled reel"),
    platform: String(reel.platform || "instagram"),
    pillar: String(reel.pillar || "General"),
    hook: String(reel.hook || "Question"),
    format: String(reel.format || "Short video"),
    postedAt: String(reel.postedAt || reel.timestamp || reel.date || new Date().toISOString()),
    views: Number(reel.views || reel.videoViewCount || reel.videoPlayCount || 0),
    likes: Number(reel.likes || reel.likesCount || 0),
    comments: Number(reel.comments || reel.commentsCount || 0),
    shares: Number(reel.shares || 0),
    saves: Number(reel.saves || 0),
    retention: Number(reel.retention || 0),
    watchTime: Number(reel.watchTime || reel.duration || 0),
    followersGained: Number(reel.followersGained || 0),
    url: String(reel.url || reel.permalink || reel.inputUrl || ""),
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
    sourceName: String(reel.sourceName || ""),
  };
}

function buildScriptSummary(post) {
  if (Array.isArray(post.scriptSummary) && post.scriptSummary.length) {
    return post.scriptSummary;
  }
  if (post.transcript) {
    return post.transcript
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6);
  }
  if (post.caption) {
    return post.caption
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6);
  }
  return [
    `${post.hook} opening tied to ${post.pillar.toLowerCase()}.`,
    `Core angle: ${postDisplayTitle(post)}.`,
    `Delivery style: ${deriveTone(post)} with ${deriveProduction(post).toLowerCase()} execution.`,
    `Recommended CTA: save this, share with one founder, or follow for the next breakdown.`
  ];
}

function postAnalysisState(post) {
  if (post.analysisStatus === "ready") return { label: "Ready", tone: "ready" };
  if (post.analysisStatus === "error") return { label: "Failed", tone: "error" };
  if (post.mediaUrl) return { label: "Can analyze", tone: "pending" };
  return { label: "Missing media", tone: "missing" };
}

function postStatusText(post) {
  if (hasRealTranscriptContent(post)) {
    return `Transcript ready${post.analysisUpdatedAt ? ` • updated ${new Date(post.analysisUpdatedAt).toLocaleString("en-IN", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}`;
  }
  if (post.analysisStatus === "ready") {
    return "AI scene notes saved, but no real transcript is attached yet.";
  }
  if (post.analysisStatus === "error") {
    return post.analysisError
      ? `Last analysis failed: ${post.analysisError}`
      : "Last analysis failed. Check media URL or provider config and retry.";
  }
  if (post.mediaUrl) {
    return "Media URL found. This reel can be transcribed and analyzed now.";
  }
  return "This reel does not have a downloadable media URL yet. Re-import with Apify video URL fields.";
}

function buildNewsPrompt(story) {
  return `Create one compact reel brief for this selected story only: ${story.headline}`;
}

function buildStoryContext(story) {
  if (!story) return null;
  return {
    id: story.id || "",
    headline: story.headline || "",
    summary: story.summary || "",
    source: story.source || "",
    publishedAt: story.publishedAt || "",
    age: story.age || "",
    topic: story.topic || "",
    nicheFitLabel: story.nicheFitLabel || "",
    recommendationLabel: story.recommendationLabel || "",
    matchedSignals: Array.isArray(story.matchedSignals) ? story.matchedSignals : [],
    url: story.url || "",
    reelBlueprint: story.reelBlueprint || null
  };
}

function competitorHookLabel(competitor) {
  if (/podcast/i.test(competitor.bestFormat)) return "Bold statement";
  if (/skit|character/i.test(competitor.bestFormat)) return "Skit / Question";
  if (/direct|camera/i.test(competitor.bestFormat)) return "Direct take";
  return "Story hook";
}

function competitorFastestContent(competitor) {
  if (/podcast/i.test(competitor.bestFormat)) return "Podcast clip moments";
  if (/skit|character/i.test(competitor.bestFormat)) return "Character-led explainers";
  if (/myth|finance/i.test(competitor.bestFormat)) return "Save-heavy myth-busting";
  return competitor.bestFormat;
}

function competitorTranscriptCoverage(competitor) {
  const reels = Array.isArray(competitor?.reels) ? competitor.reels : [];
  const total = reels.length || Number(competitor?.importedPosts || 0) || 0;
  const transcribed = reels.filter(hasRealTranscriptContent).length;
  const isFull = total > 0 && transcribed >= total;
  return {
    total,
    transcribed,
    isFull,
    label: total ? `${transcribed}/${total} transcribed` : "No reels imported",
    title: isFull ? "Fully transcribed creator" : total ? "Partial transcript coverage" : "No transcript coverage yet",
  };
}

function signedPercent(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function competitorPostsPerWeek(competitor) {
  const seeded = Number(competitor.postsPerWeek || 0);
  if (seeded) return seeded.toFixed(1);
  if (competitor.postsPerWeekLabel && competitor.postsPerWeekLabel !== "0.0") return competitor.postsPerWeekLabel;
  const importedPosts = Number(competitor.importedPosts || 0);
  return importedPosts ? (importedPosts / 4).toFixed(1) : "0.0";
}

function competitorInsights(data) {
  const competitors = (data.competitors || []).filter(Boolean);
  const creator = creatorHeadToHeadProfile(data);
  if (!competitors.length) return { advantages: [], opportunities: [] };

  const byGrowth = [...competitors].sort((left, right) => Number(right.monthlyGrowth || 0) - Number(left.monthlyGrowth || 0));
  const byEngagement = [...competitors].sort((left, right) => Number(right.engagementRate || 0) - Number(left.engagementRate || 0));
  const byViews = [...competitors].sort((left, right) => Number(right.avgViews || 0) - Number(left.avgViews || 0));
  const byCadence = [...competitors].sort((left, right) => Number(competitorPostsPerWeek(right)) - Number(competitorPostsPerWeek(left)));

  const creatorPostsPerWeek = Number(creator.postsPerWeek || 0);
  const creatorEngagement = Number(creator.engagementRate || 0);
  const creatorViews = Number(creator.avgViews || 0);
  const creatorGrowth = Number(creator.monthlyGrowth || 0);
  const creatorFormat = String(creator.bestFormat || "your current format");
  const creatorHook = String(creator.topHook || "your current hook");

  const advantages = [
    byCadence[0] && Number(competitorPostsPerWeek(byCadence[0])) > creatorPostsPerWeek
      ? {
          kicker: "Frequency",
          title: `${byCadence[0].name} is posting ${competitorPostsPerWeek(byCadence[0])} times/week vs your ${creator.postsPerWeekLabel}.`,
          body: `${byCadence[0].bestFormat} is being distributed more aggressively. You likely have more room to slice winning ideas into multiple publishable angles.`,
          source: "Source: Posting cadence • 30d"
        }
      : null,
    byEngagement[0] && Number(byEngagement[0].engagementRate || 0) > creatorEngagement
      ? {
          kicker: "Packaging",
          title: `${byEngagement[0].name} is ahead on engagement at ${byEngagement[0].engagementRateLabel}.`,
          body: `Their ${byEngagement[0].topHook || competitorHookLabel(byEngagement[0])} framing is creating a stronger response loop than your current average.`,
          source: "Source: Engagement benchmark"
        }
      : null,
    byViews[0] && Number(byViews[0].avgViews || 0) > creatorViews
      ? {
          kicker: "Trend speed",
          title: `${byViews[0].name} is pulling ${byViews[0].avgViewsLabel} avg views across visible imports.`,
          body: "That usually means sharper first-frame packaging, faster topic selection, or stronger repeatability in the winning format.",
          source: "Source: Avg views comparison"
        }
      : null,
    byGrowth[0] && Number(byGrowth[0].monthlyGrowth || 0) > creatorGrowth
      ? {
          kicker: "Momentum",
          title: `${byGrowth[0].name} is compounding fastest at ${byGrowth[0].monthlyGrowthLabel}.`,
          body: "This creator's current content mix is getting rewarded more aggressively than the rest of the watchlist.",
          source: "Source: Growth tracker"
        }
      : null
  ].filter(Boolean).slice(0, 4);

  const opportunities = [
    !competitors.some((item) => /series|recurring|weekly/i.test(String(item.bestFormat || "")))
      ? {
          kicker: "Series",
          title: "A recurring named series is still underused across the tracked set.",
          body: `Most competitors are posting one-offs. A repeatable weekly format around ${creatorHook.toLowerCase()} could build recognition faster.`,
          source: "Source: Format gap map"
        }
      : null,
    !competitors.some((item) => /founder|case|breakdown|numbers/i.test(String(item.bestFormat || "")))
      ? {
          kicker: "Open lane",
          title: `Nobody fully owns a strong "${creatorFormat}" + numbers-on-screen format.`,
          body: "That combination is still lightly occupied and can become a clear ownable lane for your business and founder content.",
          source: "Source: Cross-format analysis"
        }
      : null,
    competitors.every((item) => Number(item.monthlyGrowth || 0) < 2)
      ? {
          kicker: "Weekend slot",
          title: "Weekend publishing still looks soft across the visible watchlist.",
          body: "That opens a cheaper attention window for opinion-led, recap, or quick-response reels while rivals are quieter.",
          source: "Source: Publish-gap comparison"
        }
      : null,
    {
      kicker: "Hook gap",
      title: `Your ${creatorHook.toLowerCase()} positioning can stretch across more adjacent topics than most rivals.`,
      body: "You can bridge founder, D2C, creator-economy, and business angles with one consistent hook language while most competitors stay narrower.",
      source: "Source: Hook distribution"
    }
  ].filter(Boolean).slice(0, 4);

  return { advantages, opportunities };
}

function competitorReels() {
  return state.dashboard?.competitorReels || state.store?.competitorReels || [];
}

function competitorReelById(competitor, postId) {
  const id = String(postId || "");
  const full = competitorReels().find((item) => String(item.id) === id);
  if (full) {
    return normalizeReel({
      ...full,
      sourceHandle: full.sourceHandle || competitor?.canonicalHandle || "",
      sourceName: full.sourceName || competitor?.name || "",
    });
  }
  const summary = (competitor?.reels || []).find((item) => String(item.id) === id);
  if (!summary) return null;
  return normalizeReel({
    ...summary,
    platform: summary.platform || "instagram",
    pillar: summary.pillar || "Imported",
    hook: summary.hook || "Question",
    format: summary.format || "Video",
    mediaUrl: summary.mediaUrl || "",
    transcript: summary.transcript || "",
    timestampedTranscript: Array.isArray(summary.timestampedTranscript)
      ? summary.timestampedTranscript
      : normalizeTimestampedTranscript(summary.timestampedTranscript),
    transcriptSource: summary.transcriptSource || "",
    scriptSummary: Array.isArray(summary.scriptSummary) ? summary.scriptSummary : [],
    sceneBreakdown: Array.isArray(summary.sceneBreakdown) ? summary.sceneBreakdown : [],
    audioType: summary.audioType || "",
    tone: summary.tone || "",
    productionType: summary.productionType || "",
    cta: summary.cta || "",
    analysisStatus: summary.analysisStatus || "",
    analysisError: summary.analysisError || "",
    analysisUpdatedAt: summary.analysisUpdatedAt || "",
    analysisProvider: summary.analysisProvider || "",
    sourceHandle: summary.sourceHandle || competitor?.canonicalHandle || "",
    caption: summary.caption || "",
    language: summary.language || "",
    likes: Number(summary.likes || 0),
    comments: Number(summary.comments || 0),
    shares: Number(summary.shares || 0),
    saves: Number(summary.saves || 0),
    retention: Number(summary.retention || 0),
    watchTime: Number(summary.watchTime || 0),
    followersGained: Number(summary.followersGained || 0),
    views: Number(summary.views || 0),
    postedAt: summary.postedAt || new Date().toISOString(),
    postedAtLabel: summary.postedAtLabel || "",
    viewsLabel: summary.viewsLabel || compactNumber(summary.views || 0),
    likesLabel: compactNumber(summary.likes || 0),
    commentsLabel: compactNumber(summary.comments || 0),
    savesLabel: compactNumber(summary.saves || 0),
    engagementRateLabel: `${Number(summary.engagementRate || 0).toFixed(1)}%`,
    retentionLabel: `${Number(summary.retention || 0).toFixed(0)}%`,
    watchTimeLabel: `${Number(summary.watchTime || 0).toFixed(1)}s`,
  });
}

function toggleHidden(selector, hidden) {
  const node = $(selector);
  if (!node) return;
  node.hidden = Boolean(hidden);
}

function nonEmptyLines(lines) {
  return Array.isArray(lines)
    ? lines.map((line) => String(line || "").trim()).filter(Boolean)
    : [];
}

function meaningfulTags(tags) {
  return tags
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .filter((tag, index, items) => items.indexOf(tag) === index)
    .filter((tag) => !["Imported", "instagram", "Video", "clips"].includes(tag));
}

function visibleCompetitorStats(competitor, post) {
  return [
    { label: "Views", value: post.viewsLabel },
    { label: "Likes", value: post.likesLabel, hide: !Number(post.likes || 0) },
    { label: "Comments", value: post.commentsLabel, hide: !Number(post.comments || 0) },
    { label: "Saves", value: post.savesLabel, hide: !Number(post.saves || 0) },
    { label: "Engagement", value: post.engagementRateLabel, hide: !Number(post.likes || 0) && !Number(post.comments || 0) && !Number(post.shares || 0) && !Number(post.saves || 0) },
    { label: "Retention", value: post.retentionLabel, hide: !Number(post.retention || 0) },
    { label: "Followers", value: competitor.followersLabel, hide: !competitor.followersLabel || competitor.followersLabel === "0" },
    { label: "Source", value: post.sourceHandle || competitor.canonicalHandle || "unknown" },
  ].filter((item) => !item.hide && item.value && item.value !== "0%" && item.value !== "0");
}

function creatorHeadToHeadProfile(data) {
  const posts = data.posts || [];
  const totalViews = posts.reduce((sum, post) => sum + Number(post.views || 0), 0);
  const avgViews = posts.length ? totalViews / posts.length : 0;
  const engagementRate = average(posts.map((post) => Number(post.engagementRate || 0)));
  const bestFormat = (() => {
    const counts = new Map();
    posts.forEach((post) => {
      const key = String(post.format || "Video");
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Video";
  })();
  const hook = (() => {
    const counts = new Map();
    posts.forEach((post) => {
      const key = String(post.hook || "Question");
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Question";
  })();
  return {
    name: data.creator?.name || "Creator",
    initials: creatorInitials(),
    followersLabel: data.creator?.followersLabel || compactNumber(data.creator?.followers || 0),
    postsPerWeekLabel: competitorPostsPerWeek({ importedPosts: posts.length }),
    avgViewsLabel: compactNumber(avgViews),
    engagementRateLabel: `${engagementRate.toFixed(1)}%`,
    monthlyGrowthLabel: data.kpis?.[0]?.delta || "+0%",
    bestFormat,
    topHook: hook,
  };
}

function renderCompetitorDeepDive(data) {
  const competitors = data.competitors || [];
  const compareSelect = $("#competitorCompareSelect");
  if (!compareSelect) return;

  const preferredHandle = state.competitorCompareHandle || competitors[0]?.canonicalHandle || "";
  compareSelect.innerHTML = competitors.length
    ? competitors.map((competitor) => `<option value="${escapeHtml(competitor.canonicalHandle || "")}">${escapeHtml(competitor.name)}</option>`).join("")
    : `<option value="">No competitors yet</option>`;
  compareSelect.value = competitors.some((item) => item.canonicalHandle === preferredHandle)
    ? preferredHandle
    : (competitors[0]?.canonicalHandle || "");
  state.competitorCompareHandle = compareSelect.value;

  const competitor = competitors.find((item) => item.canonicalHandle === state.competitorCompareHandle) || competitors[0];
  const creator = creatorHeadToHeadProfile(data);

  $("#competitorHeadToHead").innerHTML = competitor ? `
    <article class="vs-card creator">
      <div class="vs-card-head">
        <span class="vs-avatar">${escapeHtml(creator.initials)}</span>
        <strong>${escapeHtml(creator.name)}</strong>
      </div>
      <div class="vs-stat-list">
        <div><span>Followers</span><strong>${escapeHtml(creator.followersLabel || "N/A")}</strong></div>
        <div><span>Posts / week</span><strong>${escapeHtml(creator.postsPerWeekLabel)}</strong></div>
        <div><span>Avg views</span><strong>${escapeHtml(creator.avgViewsLabel)}</strong></div>
        <div><span>Engagement rate</span><strong>${escapeHtml(creator.engagementRateLabel)}</strong></div>
        <div><span>Monthly growth</span><strong>${escapeHtml(creator.monthlyGrowthLabel)}</strong></div>
        <div><span>Signature format</span><strong>${escapeHtml(creator.bestFormat)}</strong></div>
        <div><span>Top hook</span><strong>${escapeHtml(creator.topHook)}</strong></div>
      </div>
    </article>
    <div class="vs-divider">VS</div>
    <article class="vs-card vs-card-action" data-open-competitor-modal="${escapeHtml(competitor.canonicalHandle || "")}" role="button" tabindex="0" aria-label="Open ${escapeHtml(competitor.name)} reel details">
      <div class="vs-card-head">
        <span class="vs-avatar soft">${escapeHtml((competitor.name || "CO").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase())}</span>
        <strong>${escapeHtml(competitor.name)}</strong>
      </div>
      <div class="vs-stat-list">
        <div><span>Followers</span><strong>${escapeHtml(competitor.followersLabel)}</strong></div>
        <div><span>Posts / week</span><strong>${escapeHtml(competitorPostsPerWeek(competitor))}</strong></div>
        <div><span>Avg views</span><strong>${escapeHtml(competitor.avgViewsLabel || compactNumber(average((competitor.reels || []).map((reel) => reel.views || 0))))}</strong></div>
        <div><span>Engagement rate</span><strong>${escapeHtml(competitor.engagementRateLabel)}</strong></div>
        <div><span>Monthly growth</span><strong>${escapeHtml(competitor.monthlyGrowthLabel)}</strong></div>
        <div><span>Signature format</span><strong>${escapeHtml(competitor.bestFormat)}</strong></div>
        <div><span>Top hook</span><strong>${escapeHtml(competitor.topHook || competitorHookLabel(competitor))}</strong></div>
      </div>
      <span class="vs-card-action-hint">Explore reels <b>→</b></span>
    </article>
  ` : emptyMarkup("No competitor records available yet.");

  document.querySelectorAll("[data-open-competitor-modal]").forEach((card) => {
    const openSelectedCompetitor = (event) => {
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const handle = card.dataset.openCompetitorModal;
      if (handle) openCompetitorModal(handle);
    };
    card.addEventListener("click", openSelectedCompetitor);
    card.addEventListener("keydown", openSelectedCompetitor);
  });

  const maxFollowers = Math.max(1, ...competitors.map((item) => parseCompactNumber(item.followersLabel || 0)));
  const maxEngagement = Math.max(1, ...competitors.map((item) => Number(item.engagementRate || 0) || 0));
  const maxGrowth = Math.max(1, ...competitors.map((item) => Math.abs(Number(item.monthlyGrowth || 0)) || 0));
  const maxViews = Math.max(1, ...competitors.map((item) => Number(item.avgViews || 0) || average((item.reels || []).map((reel) => reel.views || 0)) || 0));

  const selectedAvgViews = competitor ? (Number(competitor.avgViews || 0) || average((competitor.reels || []).map((reel) => reel.views || 0))) : 0;
  const radarRows = competitor ? [
    { label: "Followers", value: competitor.followersLabel, score: (parseCompactNumber(competitor.followersLabel || 0) / maxFollowers) * 100 },
    { label: "Avg views", value: compactNumber(selectedAvgViews), score: (selectedAvgViews / maxViews) * 100 },
    { label: "Engagement", value: competitor.engagementRateLabel, score: ((Number(competitor.engagementRate || 0) || 0) / maxEngagement) * 100 },
    { label: "Momentum", value: competitor.monthlyGrowthLabel, score: (Math.abs(Number(competitor.monthlyGrowth || 0)) / maxGrowth) * 100 },
  ] : [];

  $("#competitorRadar").innerHTML = radarRows.length
    ? radarRows.map((row) => `
        <div class="radar-row">
          <div class="radar-copy">
            <strong>${escapeHtml(row.label)}</strong>
            <span>${escapeHtml(row.value)}</span>
          </div>
          <div class="radar-track"><span style="width:${Math.max(8, Math.min(100, row.score)).toFixed(0)}%"></span></div>
        </div>
      `).join("")
    : emptyMarkup("Import competitor reels to compare positioning.");

  const viralPosts = competitors
    .flatMap((item) => (item.reels || []).map((reel) => ({ ...reel, competitorName: item.name })))
    .sort((left, right) => Number(right.views || 0) - Number(left.views || 0))
    .slice(0, 6);

  $("#competitorViralPosts").innerHTML = viralPosts.length
    ? viralPosts.map((post) => `
        <article class="viral-row">
          <div class="viral-copy">
            <strong>${escapeHtml(postDisplayTitle(post))}</strong>
            <p>${escapeHtml(post.competitorName)} • ${escapeHtml(post.postedAtLabel || "")}</p>
          </div>
          <div class="viral-metrics">
            <span>${escapeHtml(compactNumber(post.views || 0))} views</span>
            <span>${escapeHtml(compactNumber(post.likes || 0))} likes</span>
          </div>
        </article>
      `).join("")
    : emptyMarkup("No imported competitor posts yet.");

  const insightSets = competitorInsights(data);
  $("#competitorAdvantageCards").innerHTML = insightSets.advantages.length
    ? insightSets.advantages.map((item) => `
        <article class="competitor-insight-card">
          <span class="competitor-insight-kicker advantage">${escapeHtml(item.kicker)}</span>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.body)}</p>
          <small class="competitor-insight-source">${escapeHtml(item.source)}</small>
        </article>
      `).join("")
    : emptyMarkup("Import stronger competitor signals to surface cross-account advantages.");

  $("#competitorOpportunityCards").innerHTML = insightSets.opportunities.length
    ? insightSets.opportunities.map((item) => `
        <article class="competitor-insight-card">
          <span class="competitor-insight-kicker opportunity">${escapeHtml(item.kicker)}</span>
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.body)}</p>
          <small class="competitor-insight-source">${escapeHtml(item.source)}</small>
        </article>
      `).join("")
    : emptyMarkup("Add more competitor format coverage to surface open content lanes.");

  compareSelect.onchange = () => {
    const scrollSnapshot = snapshotScrollPosition();
    state.competitorCompareHandle = compareSelect.value;
    renderCompetitorDeepDive(data);
    restoreScrollSnapshot(scrollSnapshot);
    requestAnimationFrame(() => openCompetitorModal(state.competitorCompareHandle));
  };
}

function recommendationToneClass(label) {
  if (/market/i.test(label || "")) return "market";
  if (/response/i.test(label || "")) return "response";
  return "reel";
}

function normalizeCompetitorHandle(value) {
  return String(value || "").replace(/^@/, "").trim().toLowerCase();
}

function openCompetitorModal(handle) {
  const normalizedHandle = normalizeCompetitorHandle(handle);
  preserveModalScrollPosition();
  state.modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.modalReturnTarget = { type: "competitor", id: normalizedHandle };
  const competitor = (state.dashboard?.competitors || []).find((item) => {
    const canonicalHandle = normalizeCompetitorHandle(item.canonicalHandle);
    if (canonicalHandle && canonicalHandle === normalizedHandle) return true;
    if (Array.isArray(item.aliases) && item.aliases.map(normalizeCompetitorHandle).includes(normalizedHandle)) return true;
    return false;
  });
  if (!competitor) {
    const status = $("#competitorClickStatus");
    if (status) status.textContent = `Could not open ${normalizedHandle || "competitor"}. Refresh analytics and try again.`;
    console.warn("Competitor not found for modal.", { handle, normalizedHandle, competitors: state.dashboard?.competitors || [] });
    return;
  }
  const status = $("#competitorClickStatus");
  if (status) status.textContent = "";
  state.activeCompetitorHandle = normalizeCompetitorHandle(competitor.canonicalHandle || normalizedHandle);
  const reels = (competitor.reels || []).slice().sort((left, right) => new Date(right.postedAt || 0) - new Date(left.postedAt || 0));
  $("#competitorDetailHeader").innerHTML = `
    <div class="detail-title-row">
      <span class="post-thumb large">${escapeHtml((competitor.name || "CO").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase())}</span>
      <div>
        <p class="eyebrow">Competitor detail</p>
        <h3>${escapeHtml(competitor.name)}</h3>
        <p class="detail-subcopy">${escapeHtml(competitor.angle)} • ${escapeHtml(String(competitor.importedPosts || 0))} imported posts</p>
      </div>
    </div>
  `;
  $("#competitorDetailMeta").innerHTML = "";
  const reelSelect = $("#competitorReelSelect");
  reelSelect.innerHTML = reels.length
    ? reels.map((reel, index) => `<option value="${escapeHtml(reel.id)}">${escapeHtml(`${index + 1}. ${reel.postedAtLabel} • ${reel.viewsLabel} • ${shortText(postDisplayTitle(reel), "", 52)}`)}</option>`).join("")
    : `<option value="">No imported competitor reels</option>`;
  reelSelect.disabled = !reels.length;
  reelSelect.onchange = () => {
    if (reelSelect.value) openCompetitorReelDetail(reelSelect.value);
  };
  $("#competitorDetailStatus").textContent = reels.length ? "Selected opponent reel details are shown below." : "No competitor reels imported yet.";
  state.activeCompetitorPostId = reels[0]?.id || "";
  if (state.activeCompetitorPostId) {
    reelSelect.value = state.activeCompetitorPostId;
    openCompetitorReelDetail(state.activeCompetitorPostId);
  } else {
    $("#competitorSceneTimeline").innerHTML = `<p class="empty-copy">Import competitor reels to unlock scene analysis.</p>`;
    $("#competitorDetailScript").innerHTML = `<p class="empty-copy">Transcript summary will appear here after analysis.</p>`;
    $("#analyzeCompetitorReel").disabled = true;
    toggleHidden("#competitorTagsBlock", true);
    toggleHidden("#competitorStatsBlock", true);
    toggleHidden("#competitorScriptBlock", true);
  }
  $("#competitorDetailModal").hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    $("#closeCompetitorModal")?.focus({ preventScroll: true });
  });
}

window.__openCompetitorModal = openCompetitorModal;

function openCompetitorReelDetail(postId) {
  const competitor = (state.dashboard?.competitors || []).find((item) => item.canonicalHandle === state.activeCompetitorHandle);
  const post = competitorReelById(competitor, postId);
  if (!competitor || !post) return;
  state.activeCompetitorPostId = postId;
  const scenes = buildSceneTimeline(post);
  const stats = visibleCompetitorStats(competitor, post);
  const scriptLines = nonEmptyLines(buildScriptSummary(post));
  const hasMedia = Boolean(post.mediaUrl);
  const hasRealTranscript = hasRealTranscriptContent(post) || scenes.length > 0 || scriptLines.length > 0;
  const hasAnalysis = post.analysisStatus === "ready" || hasRealTranscript;
  const tags = hasAnalysis
    ? meaningfulTags([
        post.pillar,
        post.hook,
        post.tone || deriveTone(post),
        post.audioType || deriveAudio(post),
        post.productionType || deriveProduction(post),
        post.language,
      ])
    : [];
  const visibleScenes = scenes.length
    ? scenes
    : (hasRealTranscript ? buildFallbackSceneTimeline(post) : []);
  const statusLabel = hasMedia
    ? hasRealTranscript
      ? "Transcript ready"
      : "Media URL found"
    : "No media URL";

  $("#competitorDetailHeader").innerHTML = `
    <div class="detail-title-row">
      <span class="post-thumb large">${escapeHtml((post.sourceHandle || competitor.canonicalHandle || "co").slice(0, 2).toUpperCase())}</span>
      <div class="detail-heading-copy">
        <p class="eyebrow">Scene-by-scene</p>
        <h3>${escapeHtml(shortText(postDisplayTitle(post, `${competitor.name} reel breakdown`), `${competitor.name} reel breakdown`, 72))}</h3>
        <p class="detail-subcopy">@${escapeHtml(post.sourceHandle || competitor.canonicalHandle || "competitor")} • ${escapeHtml(post.postedAtLabel || "")}</p>
      </div>
    </div>
  `;

  $("#competitorDetailMeta").innerHTML = `
    <span class="detail-meta-pill">${escapeHtml(post.format || "Video")}</span>
    <span class="detail-meta-pill soft">${escapeHtml(post.platform || "instagram")}</span>
    <span class="detail-meta-pill soft">${escapeHtml(statusLabel)}</span>
    ${post.url ? `<a class="detail-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">Open ↗</a>` : ""}
  `;

  $("#competitorDetailStatus").textContent = hasMedia
    ? hasRealTranscript
      ? `Transcript ready for @${post.sourceHandle || competitor.canonicalHandle || "competitor"}.`
      : scriptLines.length
        ? "Transcript is not available yet for this reel. Caption/summary is shown below. Run analysis if media URL is present."
        : "Transcript is not available yet for this reel. Run analysis if media URL is present."
    : "This reel does not have a downloadable media URL yet.";
  if ($("#competitorReelSelect").value !== postId) {
    $("#competitorReelSelect").value = postId;
  }
  $("#analyzeCompetitorReel").disabled = !hasMedia;
  $("#analyzeCompetitorReel").hidden = !hasMedia;
  $("#analyzeCompetitorReel").textContent = post.analysisStatus === "ready" ? "Re-analyze this reel" : "Analyze this reel";
  $("#competitorSceneTimeline").innerHTML = visibleScenes.length
    ? visibleScenes.map((scene) => `
      <article class="timeline-item">
        <span class="timeline-dot"></span>
        <div>
          <strong>${escapeHtml(scene.time)}</strong>
          <p>${escapeHtml(scene.text)}</p>
        </div>
      </article>
    `).join("")
    : `<p class="empty-copy">Scene-by-scene will appear only when transcript data is actually available.</p>`;
  $("#competitorDetailStats").innerHTML = stats
    .map((item) => `<div class="detail-stat"><small>${escapeHtml(item.label)}</small><strong>${escapeHtml(item.value)}</strong></div>`)
    .join("");
  $("#competitorDetailTags").innerHTML = tags.length
    ? tags.map((tag) => `<span class="detail-tag">${escapeHtml(tag)}</span>`).join("")
    : "";
  $("#competitorDetailScript").innerHTML = scriptLines.length
    ? scriptLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")
    : `<p class="empty-copy">Transcript or caption summary is not available yet for this reel.</p>`;
  toggleHidden("#competitorTagsBlock", !tags.length);
  toggleHidden("#competitorStatsBlock", !stats.length);
  toggleHidden("#competitorScriptBlock", !scriptLines.length);
}

function closeCompetitorModal() {
  $("#competitorDetailModal").hidden = true;
  document.body.classList.remove("modal-open");
  restoreModalScrollPosition();
  state.activeCompetitorHandle = "";
  state.activeCompetitorPostId = "";
}

function wireCompetitorListInteractions() {
  if (document.body.dataset.boundCompetitorList === "true") return;

  const openFromElement = (element) => {
    const trigger = element instanceof Element
      ? element.closest("[data-open-competitor], [data-competitor-handle]")
      : null;
    const row = trigger?.closest("[data-competitor-handle]");
    if (!row || !row.closest("#competitors")) return false;
    const handle = trigger?.dataset?.openCompetitor || row?.dataset?.competitorHandle || "";
    if (!handle) return false;
    openCompetitorModal(handle);
    return true;
  };

  const openFromEvent = (event) => {
    if (!openFromElement(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  document.addEventListener("click", openFromEvent);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!openFromElement(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  });

  document.body.dataset.boundCompetitorList = "true";
}

function parseCompetitorProfilesInput(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [handle, name, angle] = line.split("|").map((part) => part?.trim() || "");
      return {
        handle: handle.replace(/^@/, ""),
        name: name || handle.replace(/^@/, ""),
        angle: angle || "Unknown angle",
        platform: "instagram",
      };
    })
    .filter((profile) => profile.handle);
}

function serializeCompetitorProfiles(profiles) {
  return (profiles || [])
    .map((profile) => [profile.handle, profile.name, profile.angle].filter(Boolean).join("|"))
    .join("\n");
}

function filteredPosts() {
  const posts = state.dashboard?.posts || [];
  const search = state.postExplorer.search.trim().toLowerCase();
  const result = posts.filter((post) => {
    if (state.postExplorer.pillar !== "all" && post.pillar !== state.postExplorer.pillar) return false;
    if (state.postExplorer.hook !== "all" && post.hook !== state.postExplorer.hook) return false;
    if (state.postExplorer.format !== "all" && post.format !== state.postExplorer.format) return false;
    if (state.postExplorer.platform !== "all" && post.platform !== state.postExplorer.platform) return false;
    if (!search) return true;
    const haystack = [
      postDisplayTitle(post),
      post.hook,
      post.pillar,
      post.format,
      post.platform,
      deriveTone(post),
      deriveAudio(post)
    ].join(" ").toLowerCase();
    return haystack.includes(search);
  });

  const sortKey = state.postExplorer.sort;
  const transcriptPriority = (post) => {
    if (hasTranscriptContent(post)) return 3;
    if (post.analysisStatus === "ready") return 1;
    return 0;
  };

  return result.sort((left, right) => {
    const priorityDiff = transcriptPriority(right) - transcriptPriority(left);
    if (priorityDiff !== 0) return priorityDiff;

    if (sortKey === "postedAt") return new Date(right.postedAt) - new Date(left.postedAt);

    const metricDiff = Number(right[sortKey] || 0) - Number(left[sortKey] || 0);
    if (metricDiff !== 0) return metricDiff;

    return new Date(right.postedAt) - new Date(left.postedAt);
  });
}

function hasTranscriptContent(post) {
  return hasRealTranscriptContent(post);
}

function hasRealTranscriptContent(post) {
  if (normalizeTimestampedTranscript(post.timestampedTranscript).length) return true;
  if (Array.isArray(post.sceneBreakdown) && post.sceneBreakdown.length) return true;
  if (String(post.transcriptSource || "").trim()) return true;
  return Boolean(String(post.transcript || "").trim());
}

function renderPostExplorer() {
  const posts = state.dashboard?.posts || [];
  $("#globalSearch").value = state.postExplorer.search;
  fillExplorerSelect("#postPillarFilter", posts.map((post) => post.pillar), state.postExplorer.pillar, "Pillar: All");
  fillExplorerSelect("#postHookFilter", posts.map((post) => post.hook), state.postExplorer.hook, "Hook: All");
  fillExplorerSelect("#postFormatFilter", posts.map((post) => post.format), state.postExplorer.format, "Format: All");
  fillExplorerSelect("#postPlatformFilter", posts.map((post) => post.platform), state.postExplorer.platform, "Platform: All");
  $("#postSort").value = state.postExplorer.sort;
  $("#postSearch").value = state.postExplorer.search;

  const list = filteredPosts();
  $("#postsCountLabel").textContent = `${list.length} of ${posts.length} posts`;
  $("#allPostsTable").innerHTML = list
    .map((post) => `
      <button type="button" class="post-row" data-post-id="${escapeHtml(post.id)}">
        <span class="post-cell post-title-cell" data-label="Post">
          <span class="post-thumb">${escapeHtml(initialsForPost(post))}</span>
          <span>
            <strong>${escapeHtml(postDisplayTitle(post))}</strong>
            ${hasTranscriptContent(post) ? `<span class="post-ready-badge">Transcript ready</span>` : ""}
            <small>${escapeHtml(post.postedAtLabel)} · ${escapeHtml(post.watchTimeLabel || "")} · ${escapeHtml(shortText(post.caption || post.transcript, "", 56))}</small>
          </span>
        </span>
        <span class="post-cell post-hook-cell" data-label="Hook">
          <span class="post-pill soft">${escapeHtml(shortText(post.hook, "", 28))}</span>
        </span>
        <span class="post-cell" data-label="Style"><span class="post-pill">${escapeHtml(post.format)}</span></span>
        <span class="post-cell" data-label="Pillar"><span class="post-pill">${escapeHtml(post.pillar)}</span></span>
        <span class="post-cell metric-stack" data-label="Views"><span class="metric-bar"><i style="width:${Math.max(6, Math.min(100, Number(post.views || 0) / Math.max(...posts.map((item) => Number(item.views || 0)), 1) * 100))}%"></i></span><strong>${escapeHtml(post.viewsLabel)}</strong></span>
        <span class="post-cell metric-stack" data-label="Retention"><strong>${escapeHtml(post.retentionLabel)}</strong></span>
        <span class="post-cell metric-stack" data-label="Engagement"><strong>${escapeHtml(post.engagementRateLabel)}</strong></span>
        <span class="post-cell metric-stack" data-label="Saves"><strong>${escapeHtml(post.savesLabel)}</strong></span>
        <span class="post-cell metric-stack positive" data-label="Followers"><strong>+${escapeHtml(post.followersLabel)}</strong></span>
      </button>
    `)
    .join("") || emptyMarkup("No posts match the current explorer filters.");

  document.querySelectorAll("[data-post-id]").forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPostModal(button.dataset.postId);
    };
  });
}

function openPostModal(postId, options = {}) {
  const keepModalScroll = Boolean(options.keepModalScroll);
  if (!keepModalScroll) preserveModalScrollPosition();
  if (!keepModalScroll) {
    state.modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  state.modalReturnTarget = { type: "post", id: postId };
  const post = (state.dashboard?.posts || []).find((item) => item.id === postId);
  if (!post) return;
  state.activePostId = postId;
  const modal = $("#postDetailModal");
  const card = modal?.querySelector(".post-detail-card");
  const timeline = $("#postSceneTimeline");
  const scenes = buildSceneTimeline(post);
  const tags = [
    post.pillar,
    post.hook,
    post.tone || deriveTone(post),
    post.audioType || deriveAudio(post),
    post.productionType || deriveProduction(post),
    post.collabLabel || "",
    post.language || post.platform
  ].filter(Boolean);
  $("#postDetailHeader").innerHTML = `
    <div class="detail-title-row">
      <span class="post-thumb large">${escapeHtml(initialsForPost(post))}</span>
      <div class="detail-heading-copy">
        <p class="eyebrow">Scene-by-scene</p>
        <h3>${escapeHtml(shortText(postDisplayTitle(post), "Reel breakdown", 72))}</h3>
        <p class="detail-subcopy">@${escapeHtml(post.sourceHandle || "creator")} • ${escapeHtml(post.postedAtLabel)}</p>
        <div class="detail-meta-row">
          <span class="detail-meta-pill">${escapeHtml(post.format)}</span>
          <span class="detail-meta-pill soft">${escapeHtml(post.platform)}</span>
          ${post.url ? `<a class="detail-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">Open ↗</a>` : ""}
        </div>
      </div>
    </div>
  `;
  $("#postDetailStatus").textContent = postStatusText(post);
  $("#analyzeCurrentReel").disabled = !post.mediaUrl;
  $("#analyzeCurrentReel").textContent = post.analysisStatus === "ready" ? "Re-analyze this reel" : "Analyze this reel";
  $("#postSceneTimeline").innerHTML = scenes
    .map((scene) => `
      <article class="timeline-item">
        <span class="timeline-dot"></span>
        <div>
          <strong>${escapeHtml(scene.time)}</strong>
          <p>${escapeHtml(scene.text)}</p>
        </div>
      </article>
    `)
    .join("") || `<p class="empty-copy">Real timestamped transcript is not attached for this reel yet.</p>`;
  $("#postDetailTags").innerHTML = tags.length
    ? tags.map((tag) => `<span class="detail-tag">${escapeHtml(tag)}</span>`).join("")
    : `<p class="empty-copy">No AI tags saved yet. Run analysis to generate hook, tone, and production labels.</p>`;
  $("#postDetailStats").innerHTML = `
    <div class="detail-stat"><small>Views</small><strong>${escapeHtml(post.viewsLabel)}</strong></div>
    <div class="detail-stat"><small>Likes</small><strong>${escapeHtml(post.likesLabel)}</strong></div>
    <div class="detail-stat"><small>Comments</small><strong>${escapeHtml(post.commentsLabel)}</strong></div>
    <div class="detail-stat"><small>Saves</small><strong>${escapeHtml(post.savesLabel)}</strong></div>
    <div class="detail-stat"><small>Engagement</small><strong>${escapeHtml(post.engagementRateLabel)}</strong></div>
    <div class="detail-stat"><small>Retention</small><strong>${escapeHtml(post.retentionLabel)}</strong></div>
    <div class="detail-stat"><small>Watch time</small><strong>${escapeHtml(post.watchTimeLabel)}</strong></div>
    <div class="detail-stat"><small>Source</small><strong>${escapeHtml(post.sourceHandle || "unknown")}</strong></div>
  `;
  $("#postDetailScript").innerHTML = buildScriptSummary(post)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("") || `<p class="empty-copy">Transcript or caption summary is not available yet for this reel.</p>`;
  if (!keepModalScroll) {
    if (card) card.scrollTop = 0;
    if (timeline) timeline.scrollTop = 0;
  }
  modal.hidden = false;
  requestAnimationFrame(() => {
    if (keepModalScroll) {
      if (card) card.scrollTop = options.modalScroll?.cardTop || 0;
      if (timeline) timeline.scrollTop = options.modalScroll?.timelineTop || 0;
      return;
    }
    if (card) card.scrollTop = 0;
    if (timeline) timeline.scrollTop = 0;
    $("#closePostModal")?.focus({ preventScroll: true });
  });
  document.body.classList.add("modal-open");
}

function closePostModal() {
  $("#postDetailModal").hidden = true;
  document.body.classList.remove("modal-open");
  restoreModalScrollPosition();
  state.activePostId = "";
}

function preserveModalScrollPosition() {
  if (document.body.classList.contains("modal-open")) return;
  const x = window.scrollX || 0;
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  const content = document.querySelector(".content");
  const contentY = content?.scrollTop || 0;
  state.modalScrollPosition = { x, y, contentY };
}

function restoreModalScrollPosition() {
  const { x, y, contentY } = state.modalScrollPosition || { x: 0, y: 0, contentY: 0 };
  const content = document.querySelector(".content");
  const returnFocus = state.modalReturnFocus;
  requestAnimationFrame(() => {
    window.scrollTo(x, y);
    if (content) content.scrollTop = contentY;
    if (returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
  });
  state.modalReturnTarget = null;
  state.modalReturnFocus = null;
}

function renderMessages() {
  $("#messages").innerHTML = state.messages
    .map(
      (message, index) => `
        <article class="message ${message.role} ${message.tone || ""}">
          <div class="message-avatar">${message.role === "assistant" ? "✦" : creatorInitials()}</div>
          <div class="message-bubble">
            <div class="message-meta">
              <strong>${message.role === "assistant" ? "Advantage Copilot" : "You"}</strong>
              <span>${message.role === "assistant" ? "Connected to your analytics" : index === state.messages.length - 1 ? "Latest" : "Saved turn"}</span>
            </div>
            <div class="message-body">${formatMessageBody(message.text, message.tone)}</div>
          ${
            message.citations?.length
              ? `<div class="citations">${message.citations
                  .map(
                    (citation) =>
                      `<button class="citation" data-citation-view="${escapeHtml(citation.view || "")}" data-citation-section="${escapeHtml(citation.section || "")}">${escapeHtml(citation.label)}</button>`,
                  )
                  .join("")}</div>`
              : ""
          }
          ${
            message.role === "assistant" && message.tone !== "thinking"
              ? `<div class="message-tools"><button class="mini-action" data-pin-message="${index}">Pin takeaway</button></div>`
              : ""
          }
          </div>
        </article>
      `,
    )
    .join("");
  $("#messages").scrollTop = $("#messages").scrollHeight;
  document.querySelectorAll("[data-citation-section]").forEach((button) => {
    button.onclick = () => {
      const view = button.dataset.citationView;
      const section = button.dataset.citationSection;
      if (view) openView(view);
      setTimeout(() => {
        document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 20);
    };
  });
  document.querySelectorAll("[data-pin-message]").forEach((button) => {
    button.onclick = () => {
      const message = state.messages[Number(button.dataset.pinMessage)];
      if (!message) return;
      state.pinnedMessages = [
        {
          id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: message.text,
          threadId: state.currentThreadId,
          title: threadPreview(state.threads.find((thread) => thread.id === state.currentThreadId) || { title: "Chat", messages: [] }),
        },
        ...state.pinnedMessages,
      ].slice(0, 8);
      persistAssistantState().catch(() => {});
      renderPinnedMessages();
    };
  });
}

function formatInline(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function formatMessageBody(text, tone) {
  if (tone === "thinking") {
    return `
      <div class="typing-block">
        <span>Thinking over your analytics</span>
        <div class="typing-dots"><i></i><i></i><i></i></div>
      </div>
    `;
  }

  const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd());
  const blocks = [];
  let listItems = [];
  let listType = "";

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(`<${listType}>${listItems.map((item) => `<li>${formatInline(item)}</li>`).join("")}</${listType}>`);
    listItems = [];
    listType = "";
  };

  lines.forEach((line) => {
    if (!line.trim()) {
      flushList();
      return;
    }
    if (/^[-*]\s+/.test(line)) {
      const nextType = "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push(line.replace(/^[-*]\s+/, ""));
      return;
    }
    if (/^\d+\.\s+/.test(line)) {
      const nextType = "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push(line.replace(/^\d+\.\s+/, ""));
      return;
    }
    flushList();
    blocks.push(`<p>${formatInline(line)}</p>`);
  });

  flushList();
  return blocks.join("") || `<p>${formatInline(text)}</p>`;
}

function renderThreadHistory() {
  const visibleThreads = state.threads.filter((thread) => thread.messages?.some((message) => message.role === "user"));
  $("#chatHistory").innerHTML = visibleThreads.length
    ? visibleThreads
        .map(
          (thread) => `
            <article class="history-item ${thread.id === state.currentThreadId ? "active" : ""}">
              <button class="history-main" data-thread-id="${thread.id}">
                <strong>${escapeHtml(threadPreview(thread))}</strong>
                <small>${new Date(thread.updatedAt).toLocaleString("en-IN", { month: "short", day: "numeric" })}</small>
              </button>
            </article>
          `,
        )
        .join("")
    : `<p class="history-empty">Your conversations will appear here.</p>`;
  document.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.onclick = () => {
      const thread = state.threads.find((item) => item.id === button.dataset.threadId);
      if (!thread) return;
      state.currentThreadId = thread.id;
      state.messages = thread.messages.map((message) => ({ ...message }));
      renderMessages();
      renderThreadHistory();
    };
  });
}

function renderPinnedMessages() {
  $("#pinnedMessages").innerHTML = state.pinnedMessages.length
    ? state.pinnedMessages
        .slice(0, 3)
        .map(
          (item) => `
            <article class="pin-item">
              <strong>${escapeHtml(item.title)}</strong>
              <p>${escapeHtml(item.text.slice(0, 120))}${item.text.length > 120 ? "..." : ""}</p>
            </article>
          `,
        )
        .join("")
    : '<div class="empty-copy">Pinned takeaways will appear here.</div>';
  document.querySelectorAll("[data-open-pin-thread]").forEach((button) => {
    button.onclick = () => {
      const thread = state.threads.find((item) => item.id === button.dataset.openPinThread);
      if (!thread) return;
      openView("assistant");
      state.currentThreadId = thread.id;
      state.messages = thread.messages.map((message) => ({ ...message }));
      renderMessages();
      renderThreadHistory();
    };
  });
  document.querySelectorAll("[data-unpin-message]").forEach((button) => {
    button.onclick = async () => {
      state.pinnedMessages = state.pinnedMessages.filter((item) => item.id !== button.dataset.unpinMessage);
      await persistAssistantState();
      renderPinnedMessages();
      renderPinnedInsights();
    };
  });
}

function renderPinnedInsights() {
  $("#pinnedInsights").innerHTML = state.pinnedMessages.length
    ? state.pinnedMessages
        .slice(0, 4)
        .map(
          (item, index) => `
            <article class="list-row">
              <span class="rank">P${index + 1}</span>
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <small>${escapeHtml(item.text.slice(0, 150))}${item.text.length > 150 ? "..." : ""}</small>
              </div>
              <div class="metric">
                <button class="mini-action" data-open-pin-thread="${item.threadId}">Open</button>
              </div>
            </article>
          `,
        )
        .join("")
    : emptyMarkup("Pinned assistant takeaways will appear here once you save them from chat.");
  document.querySelectorAll("#pinnedInsights [data-open-pin-thread]").forEach((button) => {
    button.onclick = () => {
      const thread = state.threads.find((item) => item.id === button.dataset.openPinThread);
      if (!thread) return;
      openView("assistant");
      state.currentThreadId = thread.id;
      state.messages = thread.messages.map((message) => ({ ...message }));
      renderMessages();
      renderThreadHistory();
    };
  });
}

function startNewChat() {
  const thread = createThread();
  state.threads.unshift(thread);
  state.currentThreadId = thread.id;
  state.messages = thread.messages.map((message) => ({ ...message }));
  persistAssistantState().catch(() => {});
  renderMessages();
  renderThreadHistory();
}

function emptyMarkup(message) {
  return `<div class="empty-copy">${escapeHtml(message)}</div>`;
}

function sparklineSvg(points, key, color) {
  if (!points.length) return emptyMarkup("No trend data in this range yet.");
  const values = points.map((point) => Number(point[key] || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = 520;
  const height = 220;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const normalized = values.map((value, index) => {
    const x = index * step;
    const ratio = max === min ? 0.5 : (value - min) / (max - min);
    const y = height - ratio * (height - 20) - 10;
    return [x, y];
  });
  const path = normalized.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
  const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`;
  return `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="fill-${key}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.26"></stop>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#fill-${key})"></path>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
      ${normalized
        .map(
          ([x, y], index) =>
            `<circle cx="${x}" cy="${y}" r="4" fill="${color}">
              <title>${points[index].date}: ${points[index][key]}</title>
            </circle>`,
        )
        .join("")}
    </svg>
  `;
}

function miniSparkline(points, key, color) {
  const values = points.map((point) => Number(point[key] || 0));
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = 140;
  const height = 40;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const d = values
    .map((value, index) => {
      const ratio = max === min ? 0.5 : (value - min) / (max - min);
      const x = index * step;
      const y = height - ratio * (height - 6) - 3;
      return `${index ? "L" : "M"} ${x} ${y}`;
    })
    .join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" class="mini-spark"><path d="${d}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

function renderBars(containerId, items, metricKey, color) {
  if (!items.length) {
    $(containerId).innerHTML = emptyMarkup("No comparison data available for the selected filters.");
    return;
  }
  const max = Math.max(...items.map((item) => Number(item[metricKey] || 0)), 1);
  $(containerId).innerHTML = items
    .map(
      (item) => `
        <div class="bar-row">
          <div>
            <strong>${escapeHtml(item.label)}</strong>
            <small>${item.posts} posts • ${item.avgRetention}% retention</small>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="width:${(item[metricKey] / max) * 100}%; background:${color};"></div>
          </div>
          <span class="bar-value">${item.avgViews.toLocaleString("en-IN")}</span>
        </div>
      `,
    )
    .join("");
}

function renderHeatmap(cells) {
  if (!cells.some((cell) => cell.posts)) {
    $("#heatmapGrid").innerHTML = emptyMarkup("No posting-window data in this filter range yet.");
    return;
  }
  const max = Math.max(...cells.map((cell) => cell.score), 1);
  $("#heatmapGrid").innerHTML = cells
    .map((cell) => {
      const alpha = cell.score ? 0.12 + (cell.score / max) * 0.88 : 0.08;
      return `
        <div class="heat-cell" style="background:rgba(49,92,76,${alpha});">
          <strong>${cell.dayLabel}</strong>
          <span>${cell.slotLabel}</span>
          <small>${cell.posts} posts</small>
        </div>
      `;
    })
    .join("");
}

function renderDashboard(data) {
  state.dashboard = data;
  state.filters = {
    ...state.filters,
    range: String(data.filters?.range || state.filters.range || "365"),
    pillar: data.filters?.pillar || state.filters.pillar || "all",
    hook: data.filters?.hook || state.filters.hook || "all",
    platform: data.filters?.platform || state.filters.platform || "all",
  };
  state.aiMode = data.ai?.mode || "Rule-based fallback";
  document.body.classList.remove("dashboard-loading");
  $("#heroTitle").innerHTML = highlightHeadline(data.header.title);
  $("#heroSubtitle").textContent = data.header.subtitle;
  $("#rangeLabel").textContent = data.header.rangeLabel;
  $("#syncLabel").textContent = data.header.syncLabel;
  $("#reelsSourcePill").textContent = data.dataSources?.reels?.label || "Reels";
  $("#newsSourcePill").textContent = data.dataSources?.news?.label || "News";
  $("#transcriptionPill").textContent = data.dataSources?.transcription?.label || "Transcription";
  $("#aiModePill").textContent = state.aiMode;
  const oldestPost = data.posts?.[data.posts.length - 1];
  const newestPost = data.posts?.[0];
  $("#summaryStats").textContent = `${oldestPost?.postedAtLabel || ""} – ${newestPost?.postedAtLabel || ""} · ${data.summary.posts} reels`;
  $("#profileCard").innerHTML = `
    <span class="profile-avatar">${escapeHtml(creatorInitials())}</span>
    <div class="profile-copy">
      <strong>${escapeHtml(data.creator.name)}</strong>
      <small>@${escapeHtml((data.creator.handle || data.posts?.[0]?.sourceHandle || data.creator.name || "creator").toLowerCase().replace(/\s+/g, ""))}</small>
      <small>${escapeHtml(data.creator.niche)}</small>
      <button class="profile-switch" id="switchAccess" type="button">Switch access</button>
    </div>
    <span class="live-dot" aria-hidden="true"></span>
  `;
  $("#switchAccess").onclick = () => {
    window.sessionStorage.removeItem(authRoleStorageKey);
    state.userRole = "";
    showAuthGate();
    $("#authPassword").value = "";
    $("#authPassword")?.focus();
  };
  $("#assistantPostsCount").textContent = String(data.summary.posts || 0);
  $("#assistantCompetitorCount").textContent = String(data.competitors?.length || 0);
  $("#assistantNewsCount").textContent = String(data.news?.length || 0);

  const performanceKpis = derivedPerformanceKpis(data);
  $("#kpiGrid").innerHTML = performanceKpis
    .map(
      (item) => `
        <article class="kpi-card reference-kpi ${item.size} ${item.tone}">
          <div class="kpi-head">
            <span>${escapeHtml(item.label)}</span>
          </div>
          <strong>${escapeHtml(item.value)}</strong>
          <small class="${item.delta.startsWith("+") ? "up" : "down"}">${escapeHtml(item.delta)}</small>
          ${miniSparkline(data.charts.trend || [], item.sparkKey, item.tone === "violet" ? "#b7a7dc" : "#95aad0")}
        </article>
      `,
    )
    .join("");

  const bestPost = [...(data.posts || [])].sort((left, right) => Number(right.views || 0) - Number(left.views || 0))[0];
  const tickerBits = [
    shortText(postDisplayTitle(bestPost, "No reel title"), "", 32),
    `${bestPost?.viewsLabel || "0"} views`,
    "Best hook",
    bestPost?.hook || "No hook",
    metricHasSignal(bestPost?.retentionLabel) ? `${bestPost?.retentionLabel} retention` : "",
    metricHasSignal((data.posts || []).reduce((sum, post) => sum + Number(post.saves || 0), 0)) ? `${(data.posts || []).reduce((sum, post) => sum + Number(post.saves || 0), 0).toLocaleString("en-IN")} saves in range` : "",
    metricHasSignal((data.posts || []).reduce((sum, post) => sum + Number(post.followersGained || 0), 0)) ? `+${(data.posts || []).reduce((sum, post) => sum + Number(post.followersGained || 0), 0).toLocaleString("en-IN")} followers gained` : "",
  ].filter(Boolean);
  $("#performanceTicker").innerHTML = `
    ${tickerBits.map((bit) => `<span>${escapeHtml(bit)}</span>`).join("")}
  `;

  $("#trendCanvas").innerHTML = `
    <div class="chart-stack single">
      ${sparklineSvg(data.charts.trend, "views", "#9bb0d7")}
    </div>
  `;

  $("#topReels").innerHTML = data.topReels
    .map(
      (reel, index) => `
        <div class="list-row performer-row">
          <span class="rank">0${index + 1}</span>
          <span class="performer-thumb"></span>
          <div>
            <strong>${escapeHtml(postDisplayTitle(reel))}</strong>
            <small>${escapeHtml(reel.postedAt)} · <span class="inline-tag">${escapeHtml(reel.hook)}</span> <span class="inline-tag warm">${escapeHtml(reel.pillar)}</span></small>
          </div>
          <div class="metric">
            <strong>${escapeHtml(reel.views)}</strong>
            <small>${escapeHtml(reel.retention)} ret</small>
          </div>
        </div>
      `,
    )
    .join("") || emptyMarkup("No reels found for the selected filters.");

  const weakestPosts = [...(data.posts || [])]
    .sort((left, right) => Number(left.views || 0) - Number(right.views || 0))
    .slice(0, 4);
  $("#pinnedInsights").innerHTML = weakestPosts
    .map(
      (post, index) => `
        <div class="list-row performer-row">
          <span class="rank">${index + 1}</span>
          <span class="performer-thumb cool"></span>
          <div>
            <strong>${escapeHtml(postDisplayTitle(post))}</strong>
            <small>${escapeHtml(post.postedAtLabel)} · <span class="inline-tag">${escapeHtml(post.hook)}</span> <span class="inline-tag warm">${escapeHtml(post.format)}</span></small>
          </div>
          <div class="metric">
            <strong>${escapeHtml(post.viewsLabel)}</strong>
            <small>${escapeHtml(post.retentionLabel)} ret</small>
          </div>
        </div>
      `,
    )
    .join("") || emptyMarkup("Not enough posts for a rethink list yet.");

  $("#insights").innerHTML = data.insights
    .map(
      (insight) => `
        <article class="insight-card">
          <small>${escapeHtml(insight.tag)}</small>
          <strong>${escapeHtml(insight.title)}</strong>
          <p>${escapeHtml(insight.body)}</p>
          <button class="ghost-button insight-link" data-citation-view="${escapeHtml(insight.citation.view)}" data-citation-section="${escapeHtml(insight.citation.section)}">${escapeHtml(insight.citation.label)}</button>
        </article>
      `,
    )
    .join("") || emptyMarkup("Insights will appear once enough analytics data is available.");

  $("#groupStats").innerHTML = (data.charts.hooks || []).slice(0, 3).map((item, index) => `
    <article class="group-stat-card">
      <small>${index === 0 ? "Most views" : index === 1 ? "Best retention" : "Most saves"}</small>
      <strong>${escapeHtml(item.label)}</strong>
      <span>${index === 1 ? `${escapeHtml(item.avgRetention)}% avg watch` : `${escapeHtml(compactNumber(index === 2 ? item.saves || 0 : item.avgViews))} avg`}</span>
    </article>
  `).join("");

  document.querySelectorAll(".insight-link").forEach((button) => {
    button.onclick = () => {
      openView(button.dataset.citationView);
      document.getElementById(button.dataset.citationSection)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  $("#competitors").innerHTML = data.competitors
    .map(
      (competitor) => {
        const transcriptCoverage = competitorTranscriptCoverage(competitor);
        return `
        <div
          class="competitor-row"
          role="button"
          tabindex="0"
          data-competitor-handle="${escapeHtml(normalizeCompetitorHandle(competitor.canonicalHandle || competitor.name || ""))}"
        >
          <div class="competitor-identity" data-label="Creator">
            <strong>${escapeHtml(competitor.name)}</strong>
            <small>${escapeHtml(competitor.angle)}</small>
            <span class="competitor-transcript-badge ${transcriptCoverage.isFull ? "complete" : "partial"}" title="${escapeHtml(transcriptCoverage.title)}">
              ${transcriptCoverage.isFull ? "Fully transcribed" : "Transcript"} · ${escapeHtml(transcriptCoverage.label)}
            </span>
          </div>
          <div class="competitor-metric" data-label="Followers">
            <strong>${escapeHtml(competitor.followersLabel)}</strong>
            <small>followers</small>
          </div>
          <div class="competitor-metric" data-label="Engagement">
            <strong>${escapeHtml(competitor.engagementRateLabel)}</strong>
            <small>avg engagement</small>
          </div>
          <div class="competitor-metric positive" data-label="Momentum">
            <strong>${escapeHtml(competitor.monthlyGrowthLabel)}</strong>
            <small>content momentum</small>
          </div>
          <div class="competitor-tag-cell" data-label="Top hook"><span class="post-pill soft">${escapeHtml(competitorHookLabel(competitor))}</span></div>
          <div class="competitor-tag-cell" data-label="Best format"><span class="post-pill">${escapeHtml(competitor.bestFormat)}</span></div>
          <div class="competitor-idea" data-label="Fastest signal">${escapeHtml(competitorFastestContent(competitor))}</div>
          <button
            class="competitor-open-hint competitor-open-action"
            type="button"
            data-open-competitor="${escapeHtml(normalizeCompetitorHandle(competitor.canonicalHandle || competitor.name || ""))}"
          >Open reels</button>
        </div>
      `;
      },
    )
    .join("") || emptyMarkup("No competitor records available yet.");
  const competitorStatus = $("#competitorClickStatus");
  if (competitorStatus) competitorStatus.textContent = "";
  document.querySelectorAll("#competitors [data-competitor-handle]").forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        openCompetitorModal(button.dataset.competitorHandle);
      } catch (error) {
        const status = $("#competitorClickStatus");
        if (status) status.textContent = `Could not open competitor: ${error?.message || "check console"}`;
        console.error("Competitor modal failed.", error);
      }
    };
  });
  document.querySelectorAll("#competitors [data-open-competitor]").forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        openCompetitorModal(button.dataset.openCompetitor);
      } catch (error) {
        const status = $("#competitorClickStatus");
        if (status) status.textContent = `Could not open competitor: ${error?.message || "check console"}`;
        console.error("Competitor modal action failed.", error);
      }
    };
  });

  const topCompetitor = data.competitors?.[0];
  const averageCompetitorEngagement = data.competitors?.length
    ? `${(data.competitors.reduce((total, competitor) => total + Number(competitor.engagementRate || 0), 0) / data.competitors.length).toFixed(1)}%`
    : "";
  const competitorSummaryTiles = [
    `
    <article class="summary-tile">
      <small>Creators tracked</small>
      <strong>${escapeHtml(String(data.competitors?.length || 0))}</strong>
      <p>Across ${escapeHtml(data.creator.niche || "your niche")}</p>
    </article>`,
    topCompetitor && metricHasSignal(topCompetitor?.monthlyGrowthLabel) ? `
    <article class="summary-tile">
      <small>Fastest riser</small>
      <strong>${escapeHtml(topCompetitor.name)}</strong>
      <p>${escapeHtml(topCompetitor.monthlyGrowthLabel)} content momentum vs recent posts</p>
    </article>` : "",
    metricHasSignal(averageCompetitorEngagement) ? `
    <article class="summary-tile">
      <small>Niche avg engagement</small>
      <strong>${escapeHtml(averageCompetitorEngagement)}</strong>
      <p>Your benchmark against the tracked set</p>
    </article>` : "",
  ].filter(Boolean);
  $("#competitorSummary").innerHTML = competitorSummaryTiles.join("");
  renderCompetitorDeepDive(data);

  const featuredStory = data.news?.[0];
  const categories = ["All", ...new Set((data.news || []).map((story) => story.topic).filter(Boolean).slice(0, 5))];
  if (!categories.includes(state.newsCategory)) state.newsCategory = "All";
  $("#newsCategories").innerHTML = categories
    .map(
      (category) =>
        `<button class="category-pill ${state.newsCategory === category ? "active" : ""}" data-news-category="${escapeHtml(category)}" type="button">${escapeHtml(category)}</button>`,
    )
    .join("");
  const visibleNews = (state.newsCategory === "All"
    ? (data.news || [])
    : (data.news || []).filter((story) => story.topic === state.newsCategory))
    .slice()
    .sort((left, right) => new Date(right.publishedAt || 0) - new Date(left.publishedAt || 0));
  const visibleFeaturedStory = visibleNews[0];
  const remainingStories = visibleNews.slice(1);
  $("#newsSyncStrip").innerHTML = `
    <span class="sync-badge">Updated ${escapeHtml(data.header.syncLabel.replace("Store updated ", ""))}</span>
    <button class="mini-action" id="refreshNewsAction" type="button">Refresh</button>
  `;
  $("#featuredNewsPanel").innerHTML = visibleFeaturedStory
    ? `
      <div class="featured-news-meta">
        <span>${escapeHtml(visibleFeaturedStory.source)}</span>
        <span>${escapeHtml(visibleFeaturedStory.age)}</span>
        <span class="news-fit ${recommendationToneClass(visibleFeaturedStory.recommendationLabel)}">${escapeHtml(visibleFeaturedStory.recommendationLabel)}</span>
      </div>
      <h2 class="featured-news-title">${escapeHtml(visibleFeaturedStory.headline)}</h2>
      <p class="featured-news-summary">${escapeHtml(visibleFeaturedStory.summary)}</p>
      <div class="featured-news-actions">
        <button class="primary-news-action" data-story-id="${escapeHtml(visibleFeaturedStory.id || "")}" data-story-prompt="${escapeHtml(buildNewsPrompt(visibleFeaturedStory))}" type="button">Create reel brief</button>
        ${visibleFeaturedStory.url ? `<a class="story-source-link" href="${escapeHtml(visibleFeaturedStory.url)}" target="_blank" rel="noreferrer">Source ↗</a>` : ""}
      </div>
    `
    : emptyMarkup(`No ${state.newsCategory === "All" ? "" : `${state.newsCategory.toLowerCase()} `}stories are available right now.`);

  $("#news").innerHTML = remainingStories
    .map(
      (story) => `
        <article class="news-card">
          <div class="news-meta">
            <span>${escapeHtml(story.source)}</span>
            <span>${escapeHtml(story.age)}</span>
          </div>
          <span class="news-kicker ${recommendationToneClass(story.recommendationLabel)}">${escapeHtml(story.recommendationLabel || "News signal")}</span>
          <strong>${escapeHtml(story.headline)}</strong>
          <p>${escapeHtml(story.summary)}</p>
          <div class="featured-news-actions">
            <button class="ghost-button story-ghost" data-story-id="${escapeHtml(story.id || "")}" data-story-prompt="${escapeHtml(buildNewsPrompt(story))}">Create reel brief</button>
            ${story.url ? `<a class="story-source-link" href="${escapeHtml(story.url)}" target="_blank" rel="noreferrer">Source ↗</a>` : ""}
          </div>
        </article>
      `,
    )
    .join("") || emptyMarkup("No news stories available right now.");

  document.querySelectorAll("[data-news-category]").forEach((button) => {
    button.onclick = () => {
      state.newsCategory = button.dataset.newsCategory;
      renderDashboard(data);
    };
  });

  document.querySelectorAll("[data-story-prompt]").forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selectedStory = (data.news || []).find((story) => String(story.id || "") === String(button.dataset.storyId || ""));
      jumpToAssistantChat({ freshThread: true });
      sendMessage(button.dataset.storyPrompt, {
        forceAssistantView: true,
        storyContext: buildStoryContext(selectedStory)
      });
    };
  });
  $("#refreshNewsAction").onclick = () => fetchDashboard();

  $("#suggestions").innerHTML = data.suggestions
    .map(
      (suggestion) => `
        <button class="quick-item" data-suggestion="${escapeHtml(suggestion)}">
          <span class="quick-kicker">Ask</span>
          <strong>${escapeHtml(suggestion)}</strong>
          <small>Ground answer in saved analytics</small>
        </button>
      `,
    )
    .join("");
  document.querySelectorAll("[data-suggestion]").forEach((button) => {
    button.onclick = () => sendMessage(button.dataset.suggestion);
  });
  document.querySelectorAll(".assistant-chip").forEach((button) => {
    button.onclick = () => sendMessage(button.dataset.suggestion);
  });

  renderBars("#hookBars", data.charts.hooks, "avgViews", "linear-gradient(135deg,#315c4c,#4e7a69)");
  renderBars("#pillarBars", data.charts.pillars, "avgViews", "linear-gradient(135deg,#ba8a27,#d0a44a)");
  renderHeatmap(data.charts.heatmap);
  renderPostExplorer();
  renderFilters();
  renderMessages();
  renderThreadHistory();
  renderPinnedMessages();
  renderPinnedInsights();
  renderChrome();
  renderNav();
  $("#aiMode").textContent = "Connected to your analytics · simulated";
}

function snapshotScrollPosition() {
  const content = document.querySelector(".content");
  return {
    x: window.scrollX || 0,
    y: window.scrollY || document.documentElement.scrollTop || 0,
    contentY: content?.scrollTop || 0,
  };
}

function restoreScrollSnapshot(snapshot) {
  if (!snapshot) return;
  const content = document.querySelector(".content");
  requestAnimationFrame(() => {
    window.scrollTo(snapshot.x || 0, snapshot.y || 0);
    if (content) content.scrollTop = snapshot.contentY || 0;
  });
}

async function fetchDashboard(options = {}) {
  const scrollSnapshot = options.preserveScroll ? snapshotScrollPosition() : null;
  state.loadingDashboard = true;
  document.body.classList.add("dashboard-loading");
  try {
    const response = await fetch(`/api/dashboard?${queryString()}`);
    if (!response.ok) throw new Error("Dashboard failed to load");
    renderDashboard(await response.json());
    restoreScrollSnapshot(scrollSnapshot);
  } finally {
    state.loadingDashboard = false;
    document.body.classList.remove("dashboard-loading");
  }
}

async function sendMessage(prompt, options = {}) {
  const text = String(prompt || "").trim();
  if (!text) return;
  if (options.forceAssistantView || state.activeView !== "assistant") {
    openView("assistant", { skipPageScroll: Boolean(options.forceAssistantView) });
  }
  if (!state.currentThreadId) startNewChat();
  const thread = currentThread();
  const storyContext = options.storyContext || thread?.storyContext || null;
  if (thread && options.storyContext) {
    thread.storyContext = options.storyContext;
  }
  state.messages.push({ role: "user", text, citations: [] });
  await syncCurrentThread();
  renderMessages();
  renderThreadHistory();
  $("#chatInput").value = "";
  state.messages.push({ role: "assistant", text: "Thinking over your dashboard...", citations: [], tone: "thinking" });
  renderMessages();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: text,
        filters: state.filters,
        storyContext
      }),
    });
    const result = await response.json();
    state.messages.pop();
    state.messages.push({ role: "assistant", text: result.answer, citations: result.citations || [], tone: "answer" });
  } catch {
    state.messages.pop();
    state.messages.push({ role: "assistant", text: "The analytics assistant is unavailable right now.", citations: [], tone: "error" });
  }
  await syncCurrentThread();
  renderMessages();
  renderThreadHistory();
}

async function loadStore() {
  const token = requireAdminToken();
  const response = await fetch("/api/admin/store", {
    headers: { "x-admin-token": token },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Store load failed");
  state.store = result;
  $("#creatorName").value = result.creator.name || "";
  $("#creatorNiche").value = result.creator.niche || "";
  $("#creatorHandle").value = result.creator.handle || "";
  $("#brandingTitle").value = result.branding.title || "";
  $("#brandingSubtitle").value = result.branding.subtitle || "";
  $("#importSource").value = result.integrations?.brightData?.datasetId ? "brightdata" : "apify";
  $("#apifyMode").value = result.integrations?.apify?.mode || "actor";
  $("#apifyActorId").value = result.integrations?.apify?.actorId || "";
  $("#apifyTaskId").value = result.integrations?.apify?.taskId || "";
  $("#apifyAutoImportEnabled").value = String(result.integrations?.apify?.autoImportEnabled || false);
  $("#apifyAutoImportIntervalMinutes").value = String(result.integrations?.apify?.autoImportIntervalMinutes || 60);
  $("#apifyAutoImportUsername").value = result.integrations?.apify?.autoImportUsername || "";
  $("#brightDataDatasetId").value = result.integrations?.brightData?.datasetId || "";
  syncImportSourceFields();
  $("#competitorProfilesInput").value = serializeCompetitorProfiles(result.competitorProfiles || []);
  $("#winsterEnabled").value = String(result.integrations?.winster?.enabled || false);
  $("#winsterBaseUrl").value = result.integrations?.winster?.baseUrl || "";
  $("#winsterPath").value = result.integrations?.winster?.path || "/chat";
  $("#winsterModel").value = result.integrations?.winster?.model || "";
  $("#winsterApiKey").value = result.integrations?.winster?.apiKeyStatus === "configured" ? "Configured in environment" : "";
  $("#adminStatus").textContent = `Loaded store with ${result.reels.length} reels, ${result.competitors.length} competitors, ${result.news.length} news items.`;
}

async function saveBranding() {
  const token = requireAdminToken();
  const response = await fetch("/api/admin/store", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({
      creator: {
        name: $("#creatorName").value.trim(),
        niche: $("#creatorNiche").value.trim(),
        handle: $("#creatorHandle").value.trim().replace(/^@/, ""),
      },
      branding: {
        title: $("#brandingTitle").value.trim(),
        subtitle: $("#brandingSubtitle").value.trim(),
      },
      competitorProfiles: parseCompetitorProfilesInput($("#competitorProfilesInput").value),
      integrations: {
        apify: {
          mode: $("#apifyMode").value,
          actorId: $("#apifyActorId").value.trim(),
          taskId: $("#apifyTaskId").value.trim(),
          input: JSON.parse($("#apifyInput").value || "{}"),
          autoImportEnabled: $("#apifyAutoImportEnabled").value === "true",
          autoImportIntervalMinutes: Number($("#apifyAutoImportIntervalMinutes").value || 60),
          autoImportUsername: $("#apifyAutoImportUsername").value.trim().replace(/^@/, "")
        },
        brightData: {
          datasetId: $("#brightDataDatasetId").value.trim(),
          input: Array.isArray(parseJsonSafe($("#apifyInput").value, [])) ? parseJsonSafe($("#apifyInput").value, []) : []
        },
        winster: {
          enabled: $("#winsterEnabled").value === "true",
          baseUrl: $("#winsterBaseUrl").value.trim(),
          path: $("#winsterPath").value.trim() || "/chat",
          model: $("#winsterModel").value.trim()
        },
      },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Save failed");
  $("#adminStatus").textContent = "Branding updated.";
  state.store = result.store || state.store;
  await loadStore();
  await fetchDashboard();
}

async function importStore() {
  const token = requireAdminToken();
  const response = await fetch("/api/admin/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({ payload: $("#importPayload").value }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Import failed");
  $("#adminStatus").textContent = `Imported store payload. Reels: ${result.counts.reels}, competitors: ${result.counts.competitors}, news: ${result.counts.news}`;
  state.store = result.store || state.store;
  await loadStore();
  await fetchDashboard();
}

async function runApify() {
  const token = requireAdminToken();
  const source = $("#importSource").value;
  const body = source === "brightdata"
    ? {
        source: "brightdata",
        datasetId: $("#brightDataDatasetId").value.trim(),
        input: Array.isArray(parseJsonSafe($("#apifyInput").value, [])) ? parseJsonSafe($("#apifyInput").value, []) : []
      }
    : {
        source: "apify",
        mode: $("#apifyMode").value,
        actorId: $("#apifyActorId").value.trim(),
        taskId: $("#apifyTaskId").value.trim(),
        input: JSON.parse($("#apifyInput").value || "{}"),
        strategy: $("#apifyStrategy").value,
      };
  const response = await fetch("/api/admin/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `${source} import failed`);
  state.store = result.store || state.store;
  const duplicateNote = result.skippedCounts?.duplicates ? ` Duplicates skipped: ${result.skippedCounts.duplicates}.` : "";
  const foreignNote = result.skippedCounts?.foreign ? ` Foreign-handle reels skipped: ${result.skippedCounts.foreign}.` : "";
  $("#adminStatus").textContent = `${source === "brightdata" ? "Bright Data" : "Apify"} import complete. Reels: ${result.importedCounts.reels}, news: ${result.importedCounts.news}.${duplicateNote}${foreignNote}`;
  await loadStore();
  await fetchDashboard();
}

async function refreshReelStats() {
  const token = requireAdminToken();
  const source = $("#importSource").value;
  if (source !== "apify") {
    throw new Error("Reel stats refresh is currently available for Apify imports only.");
  }

  const existingInput = parseJsonSafe($("#apifyInput").value, {});
  const username = $("#apifyAutoImportUsername").value.trim().replace(/^@/, "")
    || $("#creatorHandle").value.trim().replace(/^@/, "")
    || existingInput?.username?.[0]
    || state.store?.creator?.handle
    || "abvaidya";
  const safeInput = {
    ...existingInput,
    username: [String(username).replace(/^@/, "")],
    resultsLimit: Math.max(5, Number(existingInput?.resultsLimit || state.store?.integrations?.apify?.input?.resultsLimit || 20)),
    includeDownloadedVideo: false,
    includeTranscript: false,
    skipPinnedPosts: existingInput?.skipPinnedPosts !== false,
  };

  const response = await fetch("/api/admin/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({
      source: "apify",
      mode: $("#apifyMode").value,
      actorId: $("#apifyActorId").value.trim(),
      taskId: $("#apifyTaskId").value.trim(),
      strategy: "reels",
      input: safeInput,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Reel stats refresh failed");
  state.store = result.store || state.store;
  const duplicateNote = result.skippedCounts?.duplicates ? ` Duplicates merged: ${result.skippedCounts.duplicates}.` : "";
  $("#adminStatus").textContent = `Reel stats refreshed for @${username}. Reels updated/imported: ${result.importedCounts.reels}.${duplicateNote}`;
  $("#apifyInput").value = JSON.stringify(safeInput, null, 2);
  await loadStore();
  await fetchDashboard();
}

async function runCompetitorImport() {
  const token = requireAdminToken();
  const response = await fetch("/api/admin/competitors/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({
      limitPerHandle: 3,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Competitor import failed");
  state.store = result.store || state.store;
  $("#adminStatus").textContent = `Competitor import complete. Profiles: ${result.importedCounts.competitors}. Reels: ${result.importedCounts.reels}.`;
  await loadStore();
  await fetchDashboard();
}

async function runLiveNewsImport() {
  const token = requireAdminToken();
  const response = await fetch("/api/admin/news/import-live", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({ perQuery: 4 }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Live news import failed");
  state.store = result.store || state.store;
  $("#adminStatus").textContent = `Live news import complete. Stories: ${result.importedCounts.news}. Queries: ${(result.queries || []).join(", ")}.`;
  await loadStore();
  await fetchDashboard();
}

async function enrichReels() {
  const token = requireAdminToken();
  const response = await fetch("/api/admin/reels/enrich", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({
      limit: Number($("#enrichLimit").value || 5),
      force: $("#enrichForce").value === "true",
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Reel enrichment failed");
  const failures = Array.isArray(result.failed) ? result.failed.length : 0;
  const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
  $("#adminStatus").textContent = `Reel enrichment complete. Processed: ${result.processed}. Updated: ${result.updated}. Failed: ${failures}. Skipped: ${skipped}.`;
  state.store = result.store || state.store;
  await loadStore();
  await fetchDashboard();
}

async function analyzeSingleReel() {
  if (!state.activePostId) return;
  const token = requireAdminToken("#postDetailStatus");
  const modal = $("#postDetailModal");
  const card = modal?.querySelector(".post-detail-card");
  const timeline = $("#postSceneTimeline");
  const modalScroll = {
    cardTop: card?.scrollTop || 0,
    timelineTop: timeline?.scrollTop || 0,
  };
  $("#postDetailStatus").textContent = "Running live transcription and scene analysis for this reel...";
  const response = await fetch("/api/admin/reels/enrich", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({
      reelIds: [state.activePostId],
      limit: 1,
      force: true,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Single reel analysis failed");
  state.store = result.store || state.store;
  await loadStore();
  await fetchDashboard({ preserveScroll: true });
  const refreshed = (state.dashboard?.posts || []).find((item) => item.id === state.activePostId);
  if (refreshed) openPostModal(refreshed.id, { keepModalScroll: true, modalScroll });
  $("#adminStatus").textContent = `Single reel analysis finished. Updated: ${result.updated}. Failed: ${(result.failed || []).length}.`;
}

async function analyzeSingleCompetitorReel() {
  if (!state.activeCompetitorPostId) return;
  const token = requireAdminToken("#competitorDetailStatus");
  $("#competitorDetailStatus").textContent = "Running live transcription and scene analysis for this competitor reel...";
  const response = await fetch("/api/admin/competitor-reels/enrich", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-token": token,
    },
    body: JSON.stringify({
      reelIds: [state.activeCompetitorPostId],
      limit: 1,
      force: true,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Competitor reel analysis failed");
  const previousPostId = state.activeCompetitorPostId;
  const previousHandle = state.activeCompetitorHandle;
  state.store = result.store || state.store;
  await loadStore();
  await fetchDashboard({ preserveScroll: true });
  if (previousHandle) {
    openCompetitorModal(previousHandle);
    if (previousPostId) openCompetitorReelDetail(previousPostId);
  }
  $("#adminStatus").textContent = `Competitor reel analysis finished. Updated: ${result.updated}. Failed: ${(result.failed || []).length}.`;
}

async function exportStore() {
  try {
    await loadStore();
    $("#importPayload").value = JSON.stringify(state.store, null, 2);
    $("#adminStatus").textContent = "Current store exported into the JSON box.";
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
}

async function bootApp() {
  $("#adminToken").value = window.localStorage.getItem(adminTokenStorageKey) || "";
  try {
    await restoreAssistantState();
  } catch (error) {
    console.warn("Assistant history could not be restored.", error);
    const freshThread = createThread();
    state.threads = [freshThread];
    state.currentThreadId = freshThread.id;
    state.messages = freshThread.messages.map((message) => ({ ...message }));
  }
  await fetchDashboard();
  renderChrome();
  renderNav();
  renderMessages();
  renderThreadHistory();
  renderPinnedMessages();
  renderPinnedInsights();
}

function showAppShell() {
  document.body.classList.remove("auth-locked");
  $("#authGate").hidden = true;
  $("#appShell").hidden = false;
}

function showAuthGate() {
  document.body.classList.add("auth-locked");
  $("#appShell").hidden = true;
  $("#authGate").hidden = false;
}

function roleFromAccessCode(code) {
  const value = String(code || "").trim();
  if (value === adminAccessCode) return "admin";
  if (value === viewerAccessCode) return "viewer";
  return "";
}

function restoreUserRole() {
  window.localStorage.removeItem(authRoleStorageKey);
  window.localStorage.removeItem("creator-os-authenticated");
  const savedRole = window.sessionStorage.getItem(authRoleStorageKey);
  state.userRole = savedRole === "admin" || savedRole === "viewer" ? savedRole : "";
  document.body.dataset.role = state.userRole || "locked";
  return state.userRole;
}

function persistUserRole(role) {
  state.userRole = role;
  window.sessionStorage.setItem(authRoleStorageKey, role);
  document.body.dataset.role = role;
}

function wireAuthGate() {
  const form = $("#authForm");
  const input = $("#authPassword");
  const error = $("#authError");
  if (!form || !input || !error) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const role = roleFromAccessCode(input.value);
    if (!role) {
      error.textContent = "Incorrect code.";
      error.hidden = false;
      input.focus();
      input.select();
      return;
    }

    error.hidden = true;
    persistUserRole(role);
    showAppShell();
    try {
      await bootApp();
      requestAnimationFrame(() => $("#chatInput")?.blur());
    } catch (bootError) {
      console.error("Dashboard boot failed.", bootError);
      window.sessionStorage.removeItem(authRoleStorageKey);
      state.userRole = "";
      showAuthGate();
      error.textContent = `Dashboard load failed: ${bootError?.message || "check console"}`;
      error.hidden = false;
    }
  });

  input.addEventListener("input", () => {
    error.hidden = true;
  });
}

["rangeFilter", "pillarFilter", "hookFilter", "platformFilter"].forEach((id) => {
  $(`#${id}`).addEventListener("change", async (event) => {
    const key = id.replace("Filter", "").replace("range", "range").replace("pillar", "pillar").replace("hook", "hook").replace("platform", "platform");
    state.filters[key] = event.target.value;
    if (key === "range") {
      state.rangeMode = "preset";
      delete state.filters.from;
      delete state.filters.to;
      syncRangeToolbar();
    }
    await fetchDashboard();
  });
});

document.querySelectorAll("[data-range-segment]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.dataset.rangeSegment === "custom") {
      state.rangeMode = "custom";
      syncRangeToolbar();
      if ($("#customRangeStart").value && $("#customRangeEnd").value) await applyCustomRange();
      return;
    }
    await setPresetRange(button.dataset.rangeSegment);
  });
});

$(".mini-apply").addEventListener("click", async () => {
  await applyCustomRange();
});

["customRangeStart", "customRangeEnd"].forEach((id) => {
  $(`#${id}`).addEventListener("change", () => {
    state.rangeMode = "custom";
    syncRangeToolbar();
  });
});

[
  ["postSearch", "search"],
  ["postSort", "sort"],
  ["postPillarFilter", "pillar"],
  ["postHookFilter", "hook"],
  ["postFormatFilter", "format"],
  ["postPlatformFilter", "platform"],
].forEach(([id, key]) => {
  $( `#${id}` ).addEventListener(id === "postSearch" ? "input" : "change", (event) => {
    state.postExplorer[key] = event.target.value;
    renderPostExplorer();
  });
});

$("#globalSearch").addEventListener("input", (event) => {
  state.postExplorer.search = event.target.value;
  $("#postSearch").value = event.target.value;
  if (state.activeView !== "performance") openView("performance");
  renderPostExplorer();
});

$("#adminToken").addEventListener("input", () => {
  persistAdminToken();
});

$("#importSource").addEventListener("change", () => {
  syncImportSourceFields();
});

$("#closePostModal").onclick = closePostModal;
$("#analyzeCurrentReel").onclick = async () => {
  try {
    await analyzeSingleReel();
  } catch (error) {
    $("#postDetailStatus").textContent = error.message;
  }
};
$("#analyzeCompetitorReel").onclick = async () => {
  try {
    await analyzeSingleCompetitorReel();
  } catch (error) {
    $("#competitorDetailStatus").textContent = error.message;
  }
};
document.querySelectorAll("[data-close-post-modal]").forEach((node) => {
  node.onclick = closePostModal;
});
$("#closeCompetitorModal").onclick = closeCompetitorModal;
document.querySelectorAll("[data-close-competitor-modal]").forEach((node) => {
  node.onclick = closeCompetitorModal;
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#postDetailModal").hidden) closePostModal();
  if (event.key === "Escape" && !$("#competitorDetailModal").hidden) closeCompetitorModal();
});

$("#chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  openView("assistant");
  sendMessage($("#chatInput").value);
});

$("#newChat").onclick = () => {
  openView("assistant");
  startNewChat();
};

$("#refreshStore").onclick = async () => {
  try {
    await loadStore();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

$("#saveBranding").onclick = async () => {
  try {
    await saveBranding();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

$("#importStore").onclick = async () => {
  try {
    await importStore();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

$("#exportStore").onclick = async () => {
  await exportStore();
};

$("#runApify").onclick = async () => {
  try {
    await runApify();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

$("#refreshReelStats").onclick = async () => {
  try {
    await refreshReelStats();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

$("#runCompetitorImport").onclick = async () => {
  try {
    await runCompetitorImport();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

$("#runLiveNewsImport").onclick = async () => {
  try {
    await runLiveNewsImport();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

$("#enrichReels").onclick = async () => {
  try {
    await enrichReels();
  } catch (error) {
    $("#adminStatus").textContent = error.message;
  }
};

(async function init() {
  try {
    wireAuthGate();
    if (!restoreUserRole()) {
      showAuthGate();
      $("#authPassword")?.focus();
      return;
    }

    if (state.activeView === "admin" && !isAdminUser()) {
      state.activeView = "performance";
    }
    showAppShell();
    await bootApp();
  } catch (bootError) {
    console.error("Dashboard boot failed.", bootError);
    showAuthGate();
    const error = $("#authError");
    if (error) {
      error.textContent = `Dashboard load failed: ${bootError?.message || "check console"}`;
      error.hidden = false;
    }
  }
})();
