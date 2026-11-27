/**
 * Review actor classification: a model name (with an optional effort suffix
 * or provider prefix) to its family, lab and provider. Shared by the review
 * stats, the challenger's records and the server's review-model routing.
 */
export interface ClassifiedModel {
  readonly model: string;
  readonly effort: string;
  readonly family: string;
  readonly lab: string;
  readonly provider: string;
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  codex: "codex",
  openai: "codex",
  claude: "claudeAgent",
  claudeagent: "claudeAgent",
  "claude-code": "claudeAgent",
  anthropic: "claudeAgent",
  antigravity: "antigravity",
  agy: "antigravity",
  gemini: "antigravity",
  google: "antigravity",
  grok: "grok",
  xai: "grok",
  muse: "muse",
  glm: "acpRegistry_glm_agent",
  zai: "acpRegistry_glm_agent",
  acpregistry_glm_agent: "acpRegistry_glm_agent",
};

export function normalizeProviderId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return PROVIDER_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

const EFFORT_SUFFIX_RE = /\s*\((minimal|low|medium|high|xhigh|max|ultrathink)\)\s*$/i;

export function classifyModel(
  rawModel: string | null | undefined,
  rawProvider?: string | null,
): ClassifiedModel {
  let text = String(rawModel ?? "").trim();
  let effort = "";
  const m = EFFORT_SUFFIX_RE.exec(text);
  if (m?.[1]) {
    effort = m[1].toLowerCase();
    text = text.slice(0, m.index).trim();
  }
  let providerHint = rawProvider ?? "";
  const low = text.toLowerCase();
  const prefixMap: ReadonlyArray<readonly [string, string]> = [
    ["codex ", "codex"],
    ["claude ", "claudeAgent"],
    ["anthropic ", "claudeAgent"],
    ["openai ", "codex"],
    ["gemini ", "antigravity"],
    ["antigravity ", "antigravity"],
    ["grok ", "grok"],
    ["muse ", "muse"],
  ];
  for (const [prefix, prov] of prefixMap) {
    if (
      low.startsWith(prefix) &&
      !low.startsWith("claude-") &&
      !low.startsWith("gemini-") &&
      !low.startsWith("grok-") &&
      !low.startsWith("muse-")
    ) {
      if (!providerHint) providerHint = prov;
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  if (!effort) {
    const tl = text.toLowerCase();
    for (const tok of ["ultrathink", "xhigh", "minimal", "medium", "high", "low", "max"]) {
      if (tl.endsWith(` ${tok}`)) {
        effort = tok;
        text = text.slice(0, -(tok.length + 1)).trim();
        break;
      }
    }
  }

  const provider = normalizeProviderId(providerHint);
  const model = text || "unknown";
  const ml = model.toLowerCase();

  if (ml === "owner-bypass" || ml === "bypass") {
    return {
      model: "owner-bypass",
      effort: "",
      family: "Bypass",
      lab: "Owner",
      provider: "bypass",
    };
  }
  if (ml.includes("astra")) {
    return { model, effort, family: "Astra", lab: "OpenAI", provider: provider || "codex" };
  }
  if (ml.includes("sol") && (ml.includes("gpt") || provider === "codex")) {
    return { model, effort, family: "Sol", lab: "OpenAI", provider: provider || "codex" };
  }
  if (ml.includes("terra")) {
    return { model, effort, family: "Terra", lab: "OpenAI", provider: provider || "codex" };
  }
  if (ml.includes("luna")) {
    return { model, effort, family: "Luna", lab: "OpenAI", provider: provider || "codex" };
  }
  if (
    ml.startsWith("gpt-") ||
    ml.startsWith("o1") ||
    ml.startsWith("o3") ||
    ml.startsWith("o4") ||
    ml.startsWith("codex")
  ) {
    return { model, effort, family: "GPT", lab: "OpenAI", provider: provider || "codex" };
  }
  if (ml.includes("opus")) {
    return { model, effort, family: "Opus", lab: "Anthropic", provider: provider || "claudeAgent" };
  }
  if (ml.includes("fable")) {
    return {
      model,
      effort,
      family: "Fable",
      lab: "Anthropic",
      provider: provider || "claudeAgent",
    };
  }
  if (ml.includes("sonnet")) {
    return {
      model,
      effort,
      family: "Sonnet",
      lab: "Anthropic",
      provider: provider || "claudeAgent",
    };
  }
  if (ml.includes("haiku")) {
    return {
      model,
      effort,
      family: "Haiku",
      lab: "Anthropic",
      provider: provider || "claudeAgent",
    };
  }
  if (ml.includes("claude")) {
    return {
      model,
      effort,
      family: "Claude",
      lab: "Anthropic",
      provider: provider || "claudeAgent",
    };
  }
  if (
    ml.includes("gemini-4") ||
    ml.includes("neon") ||
    ml.includes("carbon") ||
    ml.includes("argon") ||
    ml.includes("hydrogen")
  ) {
    return {
      model,
      effort,
      family: "Gemini 4",
      lab: "Google",
      provider: provider || "antigravity",
    };
  }
  if (ml.includes("gemini")) {
    return { model, effort, family: "Gemini", lab: "Google", provider: provider || "antigravity" };
  }
  if (ml.includes("grok")) {
    return { model, effort, family: "Grok", lab: "xAI", provider: provider || "grok" };
  }
  if (ml.includes("muse")) {
    return { model, effort, family: "Muse Spark", lab: "Muse", provider: provider || "muse" };
  }
  if (ml.includes("glm")) {
    return {
      model,
      effort,
      family: "GLM",
      lab: "Zhipu",
      provider: provider || "acpRegistry_glm_agent",
    };
  }
  const labByProvider: Readonly<Record<string, string>> = {
    codex: "OpenAI",
    claudeAgent: "Anthropic",
    antigravity: "Google",
    grok: "xAI",
    muse: "Muse",
    acpRegistry_glm_agent: "Zhipu",
  };
  const firstSegment = model.split("-")[0] ?? "Unknown";
  return {
    model,
    effort,
    family:
      model === "unknown"
        ? "Unknown"
        : firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1),
    lab: labByProvider[provider] ?? "Other",
    provider: provider || "unknown",
  };
}
