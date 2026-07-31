import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, "data");
const storePath = path.join(dataDir, "store.json");
const sqlitePath = path.join(dataDir, "creator-os.db");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

function canonicalizeHook(value, fallback = "Question Hook") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  const normalized = text.toLowerCase();

  if (/(^|\b)(question hook|question|rhetorical|why|what if|have you|are you|would you|ask)(\b|$)/.test(normalized)) return "Question Hook";
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

  return fallback;
}

function transcriptOpeningText(reel) {
  const segments = Array.isArray(reel.timestampedTranscript) ? reel.timestampedTranscript : [];
  const segmentLead = segments
    .map((segment) => String(segment?.text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  const transcript = String(reel.transcript || "").replace(/\s+/g, " ").trim();
  const scriptLead = Array.isArray(reel.scriptSummary)
    ? reel.scriptSummary.map((line) => String(line || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 2).join(" ")
    : "";
  return [segmentLead, transcript, scriptLead].filter(Boolean).join(" ").slice(0, 320);
}

function fallbackOpeningText(reel) {
  const lines = [];
  const push = (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text) lines.push(text);
  };
  push(reel.caption);
  push(String(reel.title || "").replace(/^untitled reel\s*/i, ""));
  return lines.join(" ").slice(0, 220);
}

function inferHookFromOpening(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "Question Hook";
  const lower = value.toLowerCase();

  if (/^(if you're|if you are|every student|every founder|for founders|for students|for creators)\b/.test(lower)) return "Identity Hook";
  if (/^(why|what|how|when|where|who|are|can|do|did|have|has|would|should)\b/.test(lower) || value.includes("?")) return "Question Hook";
  if (/^(stop|listen|save this|watch this|remember|never|don't|do not)\b/.test(lower)) return "Command Hook";
  if (/^(\d+|₹\s?\d+|rs\.?\s?\d+|\d+%|research shows|studies show|data shows|according to)/.test(lower)) return "Data Hook";
  if (/^(three years ago|last night|yesterday|today|i still remember|when i was|once)\b/.test(lower)) return "Story Opening";
  if (/^(instagram just|big update|apple announced|breaking|just launched|announced)/.test(lower)) return "News / Announcement";
  if (/^(i lost|i got fired|this product almost exploded|nobody expected|this changed everything)/.test(lower)) return "Shock Hook";
  if (/^(before vs after|before and after|before\/after|this room looked like)/.test(lower)) return "Transformation Hook";
  if (/^(watch this|look at this|here's the demo|let me show you live)/.test(lower)) return "Demonstration Hook";
  if (/^(want to|imagine|become financially free|wake up without an alarm)/.test(lower)) return "Aspiration Hook";
  if (/^(this advice is wrong|forget everything you've heard|everyone believes this)/.test(lower)) return "Myth Busting";
  if (/^(you don't need|stop reading|college is a scam|hustle culture is fake)/.test(lower)) return "Contrarian Hook";
  if (/^(everyone does this|we've all seen|most people|rich people think differently)/.test(lower)) return "Observation Hook";
  if (/^(as a|i've spent|working with|after \d+ years|in my \d+ years)/.test(lower)) return "Authority Hook";
  if (/(\d+\s?(crore|cr|lakh|million|m|k)\b|users|customers|revenue|followers|client made)/.test(lower)) return "Social Proof";
  if (/^(learn this|double your|grow faster|build .* in \d+|increase|improve|how i doubled)/.test(lower)) return "Positive Promise";
  if (/^(i discovered|wait until|nobody expected|this completely changed|something weird)/.test(lower)) return "Curiosity Gap";
  if (/^(you're wasting|this mistake|never buy|stop doing|risk|losing|costs people)/.test(lower)) return "Negative Hook";
  if (/(\b30 seconds\b|\b5 minutes\b|\b60 seconds\b|\bin \d+ (seconds|minutes)\b)/.test(lower)) return "Speed Hook";
  if (/^(here's how|let me show you|this is the best|my workflow|how to\b)/.test(lower)) return "Direct Hook";

  return canonicalizeHook(value, "Question Hook");
}

function shouldReinfer(existingHook) {
  const normalized = String(existingHook || "").trim().toLowerCase();
  return !normalized
    || normalized.length > 60
    || ["question", "question hook", "imported", "explainer", "direct", "observation", "untitled reel"].includes(normalized);
}

function normalizeReelHook(reel) {
  const existing = canonicalizeHook(reel.hook || "", "");
  if (existing && !shouldReinfer(reel.hook)) return existing;
  const transcriptLead = transcriptOpeningText(reel);
  const inferred = inferHookFromOpening(transcriptLead || fallbackOpeningText(reel));
  return inferred || existing || "Question Hook";
}

const strategyRules = [
  ["How-To", /how[- ]?to|tutorial|step[- ]by[- ]step|actionable steps|process/],
  ["Framework", /framework|formula|blueprint|method|system|model|funnel/],
  ["Storytelling", /storytelling|narrative|beginning.*middle|conflict|resolution/],
  ["Observation", /most people|we all|i.ve noticed|human behavior|market behavior/],
  ["Authority Building", /authority|expertise|years of experience|lessons learned/],
  ["Social Proof", /revenue|followers|testimonial|clients|awards|case results/],
  ["Case Study", /case study|specific campaign|specific company|real numbers/],
  ["Breakdown", /breakdown|analy[sz]e|ad analysis|business analysis|website review/],
  ["Comparison", /comparison| vs |better than|difference|pros and cons/],
  ["Myth Busting", /myth|misconception|wrong advice|popular myth/],
  ["Personal Brand", /personal philosophy|life lesson|my opinion|my thoughts|beliefs|values/],
  ["Documentation", /day in (the )?life|building in public|behind the scenes|office vlog/],
  ["Entertainment", /comedy|meme|funny|humou?r|skit/],
  ["Inspiration", /mindset|success|dreams|purpose|motivat|inspir/],
  ["Community Building", /poll|comment below|tell me|inside joke|audience participation/],
  ["Product Led", /product|use case|problem solved|tool|app|software/],
  ["Sales", /buy now|discount|offer|book a call|cta|lead magnet|sign up/],
  ["Trend Based", /trending audio|viral format|challenge|trend|meme format/],
  ["News", /news|announcement|launch|launched|update|current event|breaking/],
  ["Reaction", /reaction|duet|reply|stitch|responding to|in response to|quote/],
  ["Challenge / Experiment", /i tried|we tested|let.s see|experiment|challenge/],
  ["Before & After", /before and after|before \/ after|transformation|growth over time|improvement/],
  ["Opinion / Hot Take", /unpopular opinion|hot take|i believe|everyone disagrees|here.s why i think/],
  ["Listicle", /top \d+|\d+ mistakes|\d+ tools|\d+ lessons|first,|second,|third,/],
  ["Education", /explain|definition|what is|concept|learn|teaches|understand|means/],
];

function strategySourceText(reel) {
  const segments = Array.isArray(reel.timestampedTranscript) ? reel.timestampedTranscript
    .map((segment) => String(segment?.text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean).slice(0, 5).join(" ") : "";
  const transcript = String(reel.transcript || "").replace(/\s+/g, " ").trim();
  const summary = Array.isArray(reel.scriptSummary) ? reel.scriptSummary.join(" ") : "";
  const fallback = [reel.caption, reel.title].filter(Boolean).join(" ");
  return (segments || transcript || summary || fallback).slice(0, 900).toLowerCase();
}

function normalizeReelStrategy(reel) {
  const existing = String(reel.strategy || "").trim();
  if (strategyRules.some(([label]) => label.toLowerCase() === existing.toLowerCase())) return existing;
  const text = strategySourceText(reel);
  return strategyRules.find(([, pattern]) => pattern.test(text))?.[0] || "Education";
}

function countHooks(reels) {
  const counts = new Map();
  for (const reel of reels || []) {
    const key = String(reel?.hook || "").trim() || "(empty)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
}

if (existsSync(storePath)) copyFileSync(storePath, path.join(dataDir, `store.before-hook-taxonomy-${timestamp}.json`));
if (existsSync(sqlitePath)) copyFileSync(sqlitePath, path.join(dataDir, `creator-os.before-hook-taxonomy-${timestamp}.db`));

const db = new DatabaseSync(sqlitePath);
const row = db.prepare("SELECT value FROM app_store WHERE key = ?").get("store");
const source = row?.value ? JSON.parse(row.value) : JSON.parse(readFileSync(storePath, "utf8"));

const next = {
  ...source,
  reels: (source.reels || []).map((reel) => ({ ...reel, hook: normalizeReelHook(reel), strategy: normalizeReelStrategy(reel) })),
  competitorReels: (source.competitorReels || []).map((reel) => ({ ...reel, hook: normalizeReelHook(reel), strategy: normalizeReelStrategy(reel) })),
};

const serialized = JSON.stringify(next, null, 2);
writeFileSync(storePath, serialized);
db.prepare(`
  INSERT INTO app_store (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`).run("store", serialized, new Date().toISOString());

console.log(JSON.stringify({
  storePath,
  sqlitePath,
  creatorHooks: countHooks(next.reels),
  competitorHooks: countHooks(next.competitorReels),
}, null, 2));
