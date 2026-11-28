/**
 * Canonical review-model identity: one spelling per model, effort split out
 * ("Model A (high)" and "model_a-HIGH" -> model-a, high). A structured effort
 * wins; a trailing effort word leaves the name only when there is none.
 */

const EFFORTS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
]);
const EFFORT_ALIASES: Readonly<Record<string, string>> = {
  "x-high": "xhigh",
  "extra-high": "xhigh",
  extrahigh: "xhigh",
  med: "medium",
};
/** Leading words that name a provider, not part of the model id ("codex gpt-6"). */
const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  codex: "codex",
  openai: "codex",
  anthropic: "claudeAgent",
  antigravity: "antigravity",
  agy: "antigravity",
  google: "antigravity",
  xai: "grok",
};
/** Name endings where "-max" is part of the model id, not an effort. */
const MAX_IS_NAME_AFTER: ReadonlySet<string> = new Set(["codex"]);
/** A trailing "(...)" or "[...]" note: an effort, a context tag, or prose. */
const TRAILING_NOTE_RE = /[([]([^()[\]]*)[)\]]\s*$/;
/** Trailing "(...)" notes that say nothing about the model's identity; "[...]" tags always drop. */
const IGNORED_NOTE_RE = /^(?:default|\d+(?:\.\d+)?\s*[km]?\s*(?:token\s+)?context(?:\s+window)?)$/i;
const ANTHROPIC_RE =
  /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?((?:-[a-z0-9.]+)*)$/;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.:-]*$/;
const MAX_RAW_LENGTH = 96;
const MAX_ID_LENGTH = 64;
const MAX_ID_SEGMENTS = 8;
const MAX_WORDS = 5;

export interface ModelIdentity {
  /** Canonical id, or "unknown" when the text is not a model name. */
  readonly model: string;
  readonly effort: string;
  /** Provider named by a leading provider word, else "". */
  readonly providerHint: string;
}

const UNKNOWN: ModelIdentity = { model: "unknown", effort: "", providerHint: "" };

/** A known effort level from structured or suffix text, else "". */
export function normalizeEffort(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const token = raw
    .trim()
    .toLowerCase()
    .replace(/[`*"'()]/g, "")
    .replace(/[\s_]+/g, "-");
  const effort = EFFORT_ALIASES[token] ?? token;
  return EFFORTS.has(effort) ? effort : "";
}

/** RAW's identity; STRUCTURED_EFFORT, a separate effort field, wins over any effort in RAW. */
export function normalizeModelIdentity(raw: unknown, structuredEffort?: unknown): ModelIdentity {
  let text = typeof raw === "string" ? raw.replace(/[`*"]/g, "").trim() : "";
  if (!text || text.length > MAX_RAW_LENGTH) return UNKNOWN;

  const fieldEffort = normalizeEffort(structuredEffort);
  let textEffort = "";
  let note = TRAILING_NOTE_RE.exec(text);
  while (note) {
    const [whole, body = ""] = note;
    const noteEffort = normalizeEffort(body);
    const ignorable = whole.startsWith("[") || IGNORED_NOTE_RE.test(body.trim());
    if (!noteEffort && !ignorable) return UNKNOWN;
    textEffort ||= noteEffort;
    text = text.slice(0, note.index).trim();
    note = TRAILING_NOTE_RE.exec(text);
  }
  text = text.slice(text.lastIndexOf("/") + 1);

  let providerHint = "";
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > MAX_WORDS) return UNKNOWN;
  const leading = words[0] ? PROVIDER_WORDS[words[0]] : undefined;
  if (leading && words.length > 1) {
    providerHint = leading;
    words.shift();
  }

  const segments = words.join("-").replace(/_/g, "-").split("-").filter(Boolean);
  const last = segments.length > 1 && !fieldEffort ? normalizeEffort(segments.at(-1)) : "";
  if (last && !(last === "max" && MAX_IS_NAME_AFTER.has(segments.at(-2) ?? ""))) {
    segments.pop();
    textEffort ||= last;
  }

  let model = segments.join("-");
  const anthropic = ANTHROPIC_RE.exec(model);
  if (anthropic) {
    const [, family, major, minor, rest] = anthropic;
    model = `claude-${family}-${major}${minor ? `-${minor}` : ""}${rest ?? ""}`;
  }
  if (
    !model ||
    model.length > MAX_ID_LENGTH ||
    segments.length > MAX_ID_SEGMENTS ||
    !MODEL_ID_RE.test(model)
  ) {
    return UNKNOWN;
  }
  return { model, effort: fieldEffort || textEffort, providerHint };
}
