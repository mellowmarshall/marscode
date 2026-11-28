/**
 * Canonical review-model identity: one spelling per model, with reasoning
 * effort split out. "Model A (high)", "model_a-HIGH" and "vendor/model-a"
 * with effort "high" all become { model: "model-a", effort: "high" }.
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
const ANTHROPIC_RE =
  /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?((?:-[a-z0-9.]+)*)$/;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const MAX_RAW_LENGTH = 96;
const MAX_ID_LENGTH = 64;
const MAX_ID_SEGMENTS = 8;

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

export function normalizeModelIdentity(raw: unknown): ModelIdentity {
  let text = typeof raw === "string" ? raw.replace(/[`*"]/g, "").trim() : "";
  if (!text || text.length > MAX_RAW_LENGTH) return UNKNOWN;

  let effort = "";
  const paren = /\(([^()]*)\)\s*$/.exec(text);
  if (paren) {
    effort = normalizeEffort(paren[1]);
    if (!effort) return UNKNOWN;
    text = text.slice(0, paren.index).trim();
  }
  text = text.replace(/\[[^\]]*\]\s*$/, "").trim();
  text = text.slice(text.lastIndexOf("/") + 1);

  let providerHint = "";
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const leading = words[0] ? PROVIDER_WORDS[words[0]] : undefined;
  if (leading && words.length > 1) {
    providerHint = leading;
    words.shift();
  }

  const segments = words.join("-").replace(/_/g, "-").split("-").filter(Boolean);
  const last = segments.length > 1 ? normalizeEffort(segments.at(-1)) : "";
  if (last) {
    segments.pop();
    effort ||= last;
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
  return { model, effort, providerHint };
}
