// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Host-owned DevTools config (~/.local/lib/ship-queue/host-config.json) and usage-aware review model resolution.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

const VALID_REVIEW_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
] as const;

export type ReviewEffort = (typeof VALID_REVIEW_EFFORTS)[number];

export interface ReviewModelSpec {
  readonly provider: string;
  readonly model: string;
  readonly effort: ReviewEffort;
}

export interface ReviewRoleConfig {
  readonly default: ReviewModelSpec;
  readonly fallbacks: ReadonlyArray<ReviewModelSpec>;
  readonly min_remaining_pct: number;
}

export interface DevtoolsHostConfig {
  readonly challenge_timeout_s: number;
  readonly playbook_challenge: ReviewRoleConfig;
  readonly ship_queue_review: ReviewRoleConfig;
  readonly guards: {
    readonly request_timeout_s: number;
    readonly grant_ttl_s: number;
  };
  readonly jobs: {
    readonly default_stall_minutes: number;
  };
  readonly devdeck: {
    readonly endpoint_override: string;
  };
}

export interface ResolvedModelCandidate extends ReviewModelSpec {
  readonly isDefault: boolean;
  readonly order: number;
  readonly available: boolean;
  readonly remainingPct: number | null;
  readonly healthy: boolean;
}

export interface ResolvedRolePlan {
  readonly role: "playbook_challenge" | "ship_queue_review";
  readonly minRemainingPct: number;
  readonly selected: ResolvedModelCandidate;
  readonly fallbackUsed: boolean;
  readonly reason: string;
  readonly candidates: ReadonlyArray<ResolvedModelCandidate>;
  readonly usageRemaining: Readonly<Record<string, number | null>>;
}

export interface ClassifiedModel {
  readonly model: string;
  readonly effort: string;
  readonly family: string;
  readonly lab: string;
  readonly provider: string;
}

export const DEFAULT_DEVTOOLS_HOST_CONFIG: DevtoolsHostConfig = {
  challenge_timeout_s: 900,
  playbook_challenge: {
    default: { provider: "codex", model: "auto:astra", effort: "medium" },
    fallbacks: [],
    min_remaining_pct: 10,
  },
  ship_queue_review: {
    default: { provider: "claudeAgent", model: "claude-fable-5-2", effort: "high" },
    fallbacks: [
      { provider: "codex", model: "gpt-6.2-sol", effort: "high" },
      { provider: "antigravity", model: "gemini-4-neon", effort: "high" },
    ],
    min_remaining_pct: 10,
  },
  guards: {
    request_timeout_s: 300,
    grant_ttl_s: 120,
  },
  jobs: {
    default_stall_minutes: 15,
  },
  devdeck: {
    endpoint_override: "",
  },
};

const VALID_EFFORT_SET = new Set<string>(VALID_REVIEW_EFFORTS);
const SAFE_PROVIDER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9.:/_@[\]-]{1,128}$/;
const SAFE_LOOPBACK_ENDPOINT_RE = /^(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/;

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

export function defaultHostConfigPath(): string {
  return NodePath.join(NodeOS.homedir(), ".local", "lib", "ship-queue", "host-config.json");
}

function normalizeProviderId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return PROVIDER_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function parseReviewModelSpec(raw: unknown): ReviewModelSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const provider = normalizeProviderId(obj.provider);
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  const rawEffort = typeof obj.effort === "string" ? obj.effort.trim().toLowerCase() : "medium";
  if (!provider || !SAFE_PROVIDER_RE.test(provider)) return null;
  if (!model || !SAFE_MODEL_RE.test(model)) return null;
  const effort: ReviewEffort = VALID_EFFORT_SET.has(rawEffort)
    ? (rawEffort as ReviewEffort)
    : "medium";
  return { provider, model, effort };
}

function parseRoleConfig(raw: unknown, defaults: ReviewRoleConfig): ReviewRoleConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      default: { ...defaults.default },
      fallbacks: defaults.fallbacks.map((item) => ({ ...item })),
      min_remaining_pct: defaults.min_remaining_pct,
    };
  }
  const obj = raw as Record<string, unknown>;
  const def = parseReviewModelSpec(obj.default) ?? { ...defaults.default };
  const seen = new Set<string>([`${def.provider}:${def.model}:${def.effort}`]);
  const fallbacks: ReviewModelSpec[] = [];
  if (Array.isArray(obj.fallbacks)) {
    for (const item of obj.fallbacks) {
      const parsed = parseReviewModelSpec(item);
      if (!parsed) continue;
      const key = `${parsed.provider}:${parsed.model}:${parsed.effort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fallbacks.push(parsed);
      if (fallbacks.length >= 12) break;
    }
  }
  return {
    default: def,
    fallbacks,
    min_remaining_pct: clampInt(obj.min_remaining_pct, defaults.min_remaining_pct, 0, 100),
  };
}

export function validateDevdeckEndpointOverride(raw: unknown): {
  readonly ok: boolean;
  readonly value: string;
  readonly error?: string;
} {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: "" };
  }
  if (typeof raw !== "string") {
    return { ok: false, value: "", error: "DevDeck endpoint override must be a string" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: "" };
  if (trimmed.length > 256 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, value: "", error: "Invalid DevDeck endpoint override" };
  }
  if (trimmed.startsWith("/")) {
    return { ok: true, value: trimmed };
  }
  const match = SAFE_LOOPBACK_ENDPOINT_RE.exec(trimmed);
  if (match?.[1]) {
    const port = Number(match[1]);
    if (port >= 1 && port <= 65535) {
      return { ok: true, value: trimmed };
    }
  }
  return {
    ok: false,
    value: "",
    error: "DevDeck endpoint must be an absolute Unix socket path or 127.0.0.1:PORT",
  };
}

const hostConfigReadCache = new Map<
  string,
  { readonly mtimeMs: number; readonly size: number; readonly raw: Record<string, unknown> }
>();

function readRawHostConfigObject(configPath: string): Record<string, unknown> {
  try {
    const stat = NodeFS.statSync(configPath);
    const cached = hostConfigReadCache.get(configPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.raw;
    }
    const raw = NodeFS.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const obj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    hostConfigReadCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, raw: obj });
    return obj;
  } catch {
    hostConfigReadCache.delete(configPath);
    return {};
  }
}

export function normalizeHostConfig(raw: Record<string, unknown>): DevtoolsHostConfig {
  const guardsRaw =
    raw.guards && typeof raw.guards === "object" && !Array.isArray(raw.guards)
      ? (raw.guards as Record<string, unknown>)
      : {};
  const jobsRaw =
    raw.jobs && typeof raw.jobs === "object" && !Array.isArray(raw.jobs)
      ? (raw.jobs as Record<string, unknown>)
      : {};
  const devdeckRaw =
    raw.devdeck && typeof raw.devdeck === "object" && !Array.isArray(raw.devdeck)
      ? (raw.devdeck as Record<string, unknown>)
      : {};
  const endpointCheck = validateDevdeckEndpointOverride(devdeckRaw.endpoint_override);

  return {
    challenge_timeout_s: clampInt(
      raw.challenge_timeout_s ?? raw.challenge_time_limit_s,
      DEFAULT_DEVTOOLS_HOST_CONFIG.challenge_timeout_s,
      30,
      900,
    ),
    playbook_challenge: parseRoleConfig(
      raw.playbook_challenge,
      DEFAULT_DEVTOOLS_HOST_CONFIG.playbook_challenge,
    ),
    ship_queue_review: parseRoleConfig(
      raw.ship_queue_review,
      DEFAULT_DEVTOOLS_HOST_CONFIG.ship_queue_review,
    ),
    guards: {
      request_timeout_s: clampInt(
        guardsRaw.request_timeout_s,
        DEFAULT_DEVTOOLS_HOST_CONFIG.guards.request_timeout_s,
        30,
        600,
      ),
      grant_ttl_s: clampInt(
        guardsRaw.grant_ttl_s,
        DEFAULT_DEVTOOLS_HOST_CONFIG.guards.grant_ttl_s,
        10,
        600,
      ),
    },
    jobs: {
      default_stall_minutes: clampInt(
        jobsRaw.default_stall_minutes,
        DEFAULT_DEVTOOLS_HOST_CONFIG.jobs.default_stall_minutes,
        1,
        240,
      ),
    },
    devdeck: {
      endpoint_override: endpointCheck.ok ? endpointCheck.value : "",
    },
  };
}

export function readDevtoolsHostConfig(
  configPath: string = defaultHostConfigPath(),
): DevtoolsHostConfig {
  return normalizeHostConfig(readRawHostConfigObject(configPath));
}

function validateSubmittedRoleConfig(roleName: string, raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `${roleName} must be an object`;
  }
  const obj = raw as Record<string, unknown>;
  if ("default" in obj && parseReviewModelSpec(obj.default) === null) {
    return `${roleName}.default has an invalid provider or model identifier`;
  }
  if ("fallbacks" in obj) {
    if (!Array.isArray(obj.fallbacks)) {
      return `${roleName}.fallbacks must be an array`;
    }
    for (let i = 0; i < obj.fallbacks.length; i += 1) {
      if (parseReviewModelSpec(obj.fallbacks[i]) === null) {
        return `${roleName}.fallbacks[${i}] has an invalid provider or model identifier`;
      }
    }
  }
  return null;
}

export function prepareMergedHostConfig(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
):
  | {
      readonly ok: true;
      readonly config: DevtoolsHostConfig;
      readonly toPersist: Record<string, unknown>;
    }
  | { readonly ok: false; readonly error: string } {
  for (const roleKey of ["playbook_challenge", "ship_queue_review"] as const) {
    if (roleKey in patch) {
      const err = validateSubmittedRoleConfig(roleKey, patch[roleKey]);
      if (err) return { ok: false, error: err };
    }
  }

  const devdeckPatch =
    patch.devdeck && typeof patch.devdeck === "object" && !Array.isArray(patch.devdeck)
      ? (patch.devdeck as Record<string, unknown>)
      : undefined;
  if (devdeckPatch && "endpoint_override" in devdeckPatch) {
    const check = validateDevdeckEndpointOverride(devdeckPatch.endpoint_override);
    if (!check.ok) {
      return { ok: false, error: check.error ?? "Invalid DevDeck endpoint override" };
    }
  }

  const sanitizedPatch: Record<string, unknown> = { ...patch };
  delete sanitizedPatch.targetHost;
  delete sanitizedPatch.host;

  const mergedRaw: Record<string, unknown> = {
    ...existing,
    ...sanitizedPatch,
    guards: {
      ...(existing.guards && typeof existing.guards === "object" ? existing.guards : {}),
      ...(sanitizedPatch.guards && typeof sanitizedPatch.guards === "object"
        ? sanitizedPatch.guards
        : {}),
    },
    jobs: {
      ...(existing.jobs && typeof existing.jobs === "object" ? existing.jobs : {}),
      ...(sanitizedPatch.jobs && typeof sanitizedPatch.jobs === "object"
        ? sanitizedPatch.jobs
        : {}),
    },
    devdeck: {
      ...(existing.devdeck && typeof existing.devdeck === "object" ? existing.devdeck : {}),
      ...devdeckPatch,
    },
  };
  const normalized = normalizeHostConfig(mergedRaw);
  const toPersist: Record<string, unknown> = {
    ...existing,
    challenge_timeout_s: normalized.challenge_timeout_s,
    playbook_challenge: normalized.playbook_challenge,
    ship_queue_review: normalized.ship_queue_review,
    guards: normalized.guards,
    jobs: normalized.jobs,
    devdeck: normalized.devdeck,
  };
  delete toPersist.challenge_time_limit_s;
  delete toPersist.targetHost;
  delete toPersist.host;
  return { ok: true, config: normalized, toPersist };
}

export function writeDevtoolsHostConfig(
  patch: Record<string, unknown>,
  configPath: string = defaultHostConfigPath(),
):
  | { readonly ok: true; readonly config: DevtoolsHostConfig }
  | { readonly ok: false; readonly error: string } {
  const existing = readRawHostConfigObject(configPath);
  const prepared = prepareMergedHostConfig(existing, patch);
  if (!prepared.ok) {
    return prepared;
  }

  try {
    const dir = NodePath.dirname(configPath);
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmpPath = NodePath.join(dir, `.host-config.json.tmp.${process.pid}.${Date.now()}`);
    NodeFS.writeFileSync(tmpPath, `${JSON.stringify(prepared.toPersist, null, 2)}\n`, {
      mode: 0o600,
    });
    NodeFS.renameSync(tmpPath, configPath);
    hostConfigReadCache.delete(configPath);
    return { ok: true, config: prepared.config };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write host-config.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function remainingFromUsageLimits(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
  modelId?: string,
): number | null {
  if (
    !limits ||
    limits.unavailable ||
    !Array.isArray(limits.windows) ||
    limits.windows.length === 0
  ) {
    return null;
  }
  const activeUsed: number[] = [];
  for (const w of limits.windows) {
    if (w.resetsAt) {
      const resetMs = Date.parse(w.resetsAt);
      if (Number.isFinite(resetMs) && resetMs <= nowMs) continue;
    }
    if (modelId && Array.isArray(w.modelIds) && w.modelIds.length > 0) {
      const target = modelId.toLowerCase();
      if (!w.modelIds.some((id: string) => id.toLowerCase() === target)) continue;
    }
    if (typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent)) {
      activeUsed.push(w.usedPercent);
    }
  }
  if (activeUsed.length === 0) return null;
  return Math.max(0, Math.min(100, Math.round((100 - Math.max(...activeUsed)) * 10) / 10));
}

function collectUsageRemainingMap(
  options: {
    readonly providers?: ReadonlyArray<ServerProvider> | undefined;
    readonly limitSources?: ReadonlyArray<UsageLimitSourceSnapshot> | undefined;
    readonly nowMs?: number | undefined;
  } = {},
): Record<string, number | null> {
  const nowMs = options.nowMs ?? Date.now();
  const map: Record<string, number | null> = {};

  // Live T3 Code provider usageLimits.
  for (const prov of options.providers ?? []) {
    const key = normalizeProviderId(prov.instanceId);
    const rem = remainingFromUsageLimits(prov.usageLimits, nowMs);
    if (rem !== null) {
      map[key] = rem;
    }
    if (prov.driver === "antigravity" && prov.usageLimits && !prov.usageLimits.unavailable) {
      const geminiRem = remainingFromUsageLimits(prov.usageLimits, nowMs, "gemini-4-neon");
      if (geminiRem !== null) map["antigravity:gemini"] = geminiRem;
    }
  }

  // Overlay multi-account UsageLimitSources (e.g. Claude proxy hubs): take highest remaining account per driver.
  const sourceBestByDriver = new Map<string, number>();
  for (const src of options.limitSources ?? []) {
    for (const acc of src.accounts ?? []) {
      const rem = remainingFromUsageLimits(acc.usageLimits, nowMs);
      if (rem === null) continue;
      const key = normalizeProviderId(acc.driver);
      const prev = sourceBestByDriver.get(key);
      if (prev === undefined || rem > prev) {
        sourceBestByDriver.set(key, rem);
      }
    }
  }
  for (const [key, rem] of sourceBestByDriver.entries()) {
    map[key] = rem;
  }

  return map;
}

function remainingForSpec(
  spec: ReviewModelSpec,
  usageMap: Readonly<Record<string, number | null>>,
): number | null {
  if (spec.provider === "antigravity") {
    const ml = spec.model.toLowerCase();
    if (ml.startsWith("claude") || ml.startsWith("gpt")) {
      const bucket = usageMap["antigravity:claude+gpt"];
      if (bucket !== undefined && bucket !== null) return bucket;
    }
    const gemBucket = usageMap["antigravity:gemini"];
    if (gemBucket !== undefined && gemBucket !== null) return gemBucket;
  }
  const val = usageMap[spec.provider];
  return val === undefined ? null : val;
}

export function resolveReviewRolePlan(
  role: "playbook_challenge" | "ship_queue_review",
  config: DevtoolsHostConfig,
  options: {
    readonly providers?: ReadonlyArray<ServerProvider> | undefined;
    readonly limitSources?: ReadonlyArray<UsageLimitSourceSnapshot> | undefined;
    readonly availability?: Readonly<Record<string, boolean>> | undefined;
    readonly nowMs?: number | undefined;
  } = {},
): ResolvedRolePlan {
  const roleCfg = config[role];
  const threshold = roleCfg.min_remaining_pct;
  const usageMap = collectUsageRemainingMap(options);

  const availFromProviders: Record<string, boolean> = {};
  for (const prov of options.providers ?? []) {
    availFromProviders[normalizeProviderId(prov.instanceId)] = prov.enabled;
  }
  const hasExplicitAvail =
    options.availability !== undefined ||
    (options.providers !== undefined && options.providers.length > 0);
  const isAvailable = (providerId: string): boolean => {
    if (options.availability && providerId in options.availability) {
      return Boolean(options.availability[providerId]);
    }
    if (hasExplicitAvail && providerId in availFromProviders) {
      return Boolean(availFromProviders[providerId]);
    }
    return true;
  };

  const enrich = (
    spec: ReviewModelSpec,
    isDefault: boolean,
    order: number,
  ): ResolvedModelCandidate => {
    const available = isAvailable(spec.provider);
    const remainingPct = remainingForSpec(spec, usageMap);
    const healthy = available && (remainingPct === null || remainingPct >= threshold);
    return {
      ...spec,
      isDefault,
      order,
      available,
      remainingPct,
      healthy,
    };
  };

  const defaultCand = enrich(roleCfg.default, true, 0);
  const fallbackCands = roleCfg.fallbacks.map((fb, idx) => enrich(fb, false, idx + 1));

  const rankTier = (item: ResolvedModelCandidate): readonly [number, number, number] => {
    if (!item.available) return [3, 0, item.order];
    if (item.remainingPct !== null && item.remainingPct >= threshold) {
      return [0, -item.remainingPct, item.order];
    }
    if (item.remainingPct === null) return [1, 0, item.order];
    if (item.remainingPct > 0) return [2, -item.remainingPct, item.order];
    return [3, 0, item.order];
  };

  const rankedFallbacks = [...fallbackCands].toSorted((a, b) => {
    const [ta, ra, oa] = rankTier(a);
    const [tb, rb, ob] = rankTier(b);
    if (ta !== tb) return ta - tb;
    if (ra !== rb) return ra - rb;
    return oa - ob;
  });

  let candidates: ReadonlyArray<ResolvedModelCandidate>;
  let reason: string;
  if (defaultCand.healthy) {
    candidates = [defaultCand, ...rankedFallbacks];
    reason = "default_healthy";
  } else {
    const healthyFallbacks = rankedFallbacks.filter((fb) => fb.healthy);
    if (healthyFallbacks.length > 0) {
      candidates = [...rankedFallbacks, defaultCand];
      reason = !defaultCand.available
        ? "default_unavailable"
        : `default_below_threshold(${defaultCand.remainingPct}%<${threshold}%)`;
    } else {
      // Neither default nor any fallback clears threshold: rank default alongside fallbacks by remaining %.
      const rankedAll = [defaultCand, ...fallbackCands].toSorted((a, b) => {
        const [ta, ra, oa] = rankTier(a);
        const [tb, rb, ob] = rankTier(b);
        if (ta !== tb) return ta - tb;
        if (ra !== rb) return ra - rb;
        return oa - ob;
      });
      candidates = rankedAll;
      reason = rankedAll[0]?.isDefault
        ? "no_healthier_fallback"
        : !defaultCand.available
          ? "default_unavailable"
          : `default_below_threshold(${defaultCand.remainingPct}%<${threshold}%)`;
    }
  }

  const selected = candidates[0]!;
  return {
    role,
    minRemainingPct: threshold,
    selected,
    fallbackUsed: !selected.isDefault,
    reason,
    candidates,
    usageRemaining: usageMap,
  };
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
