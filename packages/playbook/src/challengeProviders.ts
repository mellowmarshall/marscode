// @effect-diagnostics nodeBuiltinImport:off - Provider CLI discovery, host-config loading, and argv construction for `playbook challenge`.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PLAYBOOK_CHALLENGE_JSON_SCHEMA } from "./challengeReply.ts";
import { normalizeProviderId } from "./modelClassify.ts";

const DEFAULT_CHALLENGE_TIMEOUT_S = 900;
export const MIN_CHALLENGE_TIMEOUT_S = 30;
export const MAX_CHALLENGE_TIMEOUT_S = 900;
export const CATALOG_TIMEOUT_MS = 30_000;
const DEFAULT_EFFORT = "medium";
const ASTRA_SLUG_RE = /^gpt-(\d+(?:\.\d+)*)-astra$/;
const CODEX_DISABLED_FEATURES = ["memories", "browser_use", "computer_use", "in_app_browser"];

const CODEX_EFFORT_MAP: Readonly<Record<string, string>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultrathink: "xhigh",
};

const CLAUDE_DENY_READ_PATHS = [
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.claude/**)",
  "Read(~/.codex/**)",
  "Read(~/.config/**)",
  "Read(~/.t3/**)",
  "Read(/etc/**)",
] as const;

const CLAUDE_EFFORT_MAP: Readonly<Record<string, string>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultrathink: "max",
};

const GROK_EFFORT_MAP: Readonly<Record<string, string>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
  ultrathink: "xhigh",
};

const PROVIDER_BINARIES: Readonly<Record<string, string>> = {
  codex: "codex",
  claudeAgent: "claude",
  antigravity: "agy",
  grok: "grok",
};

export interface ChallengeCandidateSpec {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}

export interface HostChallengeConfig {
  readonly timeoutSec: number;
  readonly candidates: ReadonlyArray<ChallengeCandidateSpec>;
}

export interface BuiltProviderInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdinText: string;
  readonly resolvedModel: string;
  readonly resolvedEffort: string;
  readonly answerFile?: string | undefined;
}

const DEFAULT_CANDIDATE: ChallengeCandidateSpec = {
  provider: "codex",
  model: "auto:astra",
  effort: DEFAULT_EFFORT,
};

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || NodeOS.homedir();
}

function defaultHostConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.PLAYBOOK_HOST_CONFIG?.trim();
  if (explicit) return explicit;
  return NodePath.join(resolveHome(env), ".local", "lib", "ship-queue", "host-config.json");
}

function parseCandidate(raw: unknown): ChallengeCandidateSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const provider = normalizeProviderId(rec.provider);
  if (!provider) return null;
  const model = typeof rec.model === "string" ? rec.model.trim() : "";
  const effort =
    typeof rec.effort === "string" && rec.effort.trim()
      ? rec.effort.trim().toLowerCase()
      : DEFAULT_EFFORT;
  return { provider, model, effort };
}

export function readHostChallengeConfig(env: NodeJS.ProcessEnv): HostChallengeConfig {
  const path = defaultHostConfigPath(env);
  if (!NodeFS.existsSync(path)) {
    return { timeoutSec: DEFAULT_CHALLENGE_TIMEOUT_S, candidates: [DEFAULT_CANDIDATE] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return { timeoutSec: DEFAULT_CHALLENGE_TIMEOUT_S, candidates: [DEFAULT_CANDIDATE] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { timeoutSec: DEFAULT_CHALLENGE_TIMEOUT_S, candidates: [DEFAULT_CANDIDATE] };
  }
  const cfg = parsed as Record<string, unknown>;
  const rawTimeout = cfg.challenge_timeout_s ?? cfg.challenge_time_limit_s;
  const timeoutSec =
    typeof rawTimeout === "number" &&
    Number.isInteger(rawTimeout) &&
    rawTimeout >= MIN_CHALLENGE_TIMEOUT_S &&
    rawTimeout <= MAX_CHALLENGE_TIMEOUT_S
      ? rawTimeout
      : DEFAULT_CHALLENGE_TIMEOUT_S;

  if (!("playbook_challenge" in cfg)) {
    return { timeoutSec, candidates: [DEFAULT_CANDIDATE] };
  }
  const role = cfg.playbook_challenge;
  if (role === null) return { timeoutSec, candidates: [] };
  if (typeof role !== "object" || Array.isArray(role)) {
    return { timeoutSec, candidates: [DEFAULT_CANDIDATE] };
  }
  const roleRec = role as Record<string, unknown>;
  const candidates: ChallengeCandidateSpec[] = [];
  const primary = parseCandidate(roleRec.default);
  if (primary) candidates.push(primary);
  if (Array.isArray(roleRec.fallbacks)) {
    for (const fb of roleRec.fallbacks) {
      const spec = parseCandidate(fb);
      if (spec) candidates.push(spec);
    }
  }
  return { timeoutSec, candidates };
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!NodeFS.statSync(filePath).isFile()) return false;
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findProviderBinary(provider: string, env: NodeJS.ProcessEnv): string | null {
  const binary = PROVIDER_BINARIES[provider];
  if (!binary) return null;
  const pathEntries = (env.PATH ?? "").split(NodePath.delimiter).filter(Boolean);
  const candidates = [
    ...pathEntries.map((dir) => NodePath.join(dir, binary)),
    NodePath.join(resolveHome(env), ".local", "bin", binary),
    `/usr/local/bin/${binary}`,
    `/usr/bin/${binary}`,
  ];
  return candidates.find(isExecutableFile) ?? null;
}

function compareVersions(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pickLatestAstraFromCatalog(catalogJson: string, effort: string): string {
  const parsed = JSON.parse(catalogJson) as { models?: unknown };
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error("invalid Codex model catalog");
  }
  const matches: Array<{ readonly version: ReadonlyArray<number>; readonly slug: string }> = [];
  for (const entry of parsed.models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const model = entry as Record<string, unknown>;
    if (model.visibility !== "list" || model.supported_in_api === false) continue;
    if (typeof model.slug !== "string") continue;
    const m = ASTRA_SLUG_RE.exec(model.slug);
    if (!m?.[1]) continue;
    const levels = model.supported_reasoning_levels;
    if (
      !Array.isArray(levels) ||
      !levels.some(
        (lvl) =>
          lvl &&
          typeof lvl === "object" &&
          !Array.isArray(lvl) &&
          (lvl as Record<string, unknown>).effort === effort,
      )
    ) {
      continue;
    }
    matches.push({
      version: m[1].split(".").map((n) => Number.parseInt(n, 10)),
      slug: model.slug,
    });
  }
  if (matches.length === 0) {
    throw new Error(`the Codex catalog has no Astra model at ${effort} effort`);
  }
  matches.sort((a, b) => compareVersions(a.version, b.version));
  return matches.at(-1)!.slug;
}

export function readCachedCodexAstraModel(effort: string, env: NodeJS.ProcessEnv): string | null {
  const codexHome = env.CODEX_HOME?.trim() || NodePath.join(resolveHome(env), ".codex");
  const cachePath = NodePath.join(codexHome, "models_cache.json");
  if (!NodeFS.existsSync(cachePath)) return null;
  try {
    return pickLatestAstraFromCatalog(NodeFS.readFileSync(cachePath, "utf8"), effort);
  } catch {
    return null;
  }
}

export function normalizeCodexEffort(raw: string): string {
  return CODEX_EFFORT_MAP[raw.trim().toLowerCase()] ?? DEFAULT_EFFORT;
}

export function needsCodexAstraLookup(candidate: ChallengeCandidateSpec): boolean {
  return (
    candidate.provider === "codex" &&
    (!candidate.model || candidate.model === "auto:astra" || candidate.model === "astra")
  );
}

function readClaudeAuthSettings(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const cfgDir = env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(resolveHome(env), ".claude");
  const settingsPath = NodePath.join(cfgDir, "settings.json");
  if (!NodeFS.existsSync(settingsPath)) return {};
  try {
    const data = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const rec = data as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof rec.apiKeyHelper === "string" && rec.apiKeyHelper.trim()) {
      out.apiKeyHelper = rec.apiKeyHelper.trim();
    }
    if (rec.env && typeof rec.env === "object" && !Array.isArray(rec.env)) {
      const keep: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
        if (k.startsWith("ANTHROPIC_") && typeof v === "string") keep[k] = v;
      }
      if (Object.keys(keep).length > 0) out.env = keep;
    }
    return out;
  } catch {
    return {};
  }
}

export function buildProviderInvocation(input: {
  readonly candidate: ChallengeCandidateSpec;
  readonly binary: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly resolvedCodexModel?: string | undefined;
}): BuiltProviderInvocation {
  const { candidate, binary, cwd, prompt, workDir, env } = input;
  const schemaPath = NodePath.join(workDir, "schema.json");
  const schemaJson = JSON.stringify(PLAYBOOK_CHALLENGE_JSON_SCHEMA);
  NodeFS.writeFileSync(schemaPath, schemaJson, "utf8");

  if (candidate.provider === "codex") {
    const effort = normalizeCodexEffort(candidate.effort || DEFAULT_EFFORT);
    const model = input.resolvedCodexModel?.trim() || candidate.model;
    if (!model || model === "auto:astra" || model === "astra") {
      throw new Error("Codex Astra model must be resolved before building invocation");
    }
    const answerFile = NodePath.join(workDir, "answer.txt");
    const disabledFlags = CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f]);
    return {
      command: binary,
      args: [
        "exec",
        "--json",
        "-m",
        model,
        "-c",
        `model_reasoning_effort=${effort}`,
        "-c",
        "project_doc_max_bytes=0",
        "--ignore-user-config",
        "-s",
        "read-only",
        ...disabledFlags,
        "--output-schema",
        schemaPath,
        "-C",
        cwd,
        "-o",
        answerFile,
        "-",
      ],
      stdinText: prompt,
      resolvedModel: model,
      resolvedEffort: effort,
      answerFile,
    };
  }

  if (candidate.provider === "claudeAgent") {
    const effort = CLAUDE_EFFORT_MAP[candidate.effort] ?? DEFAULT_EFFORT;
    const authSettings = readClaudeAuthSettings(env);
    const authEnv = authSettings.env as Record<string, string> | undefined;
    const useBare = Boolean(
      authSettings.apiKeyHelper || env.ANTHROPIC_API_KEY || authEnv?.ANTHROPIC_API_KEY,
    );
    const settingsPath = NodePath.join(workDir, "claude-settings.json");
    NodeFS.writeFileSync(
      settingsPath,
      JSON.stringify({ ...authSettings, permissions: { deny: [...CLAUDE_DENY_READ_PATHS] } }),
      "utf8",
    );
    const args = ["--print", useBare ? "--bare" : "--safe-mode", "--settings", settingsPath];
    if (candidate.model) args.push("--model", candidate.model);
    args.push(
      "--effort",
      effort,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--json-schema",
      schemaJson,
      "--restricted",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--tools",
      "Read,Glob,Grep",
    );
    return {
      command: binary,
      args,
      stdinText: prompt,
      resolvedModel: candidate.model || "claude",
      resolvedEffort: effort,
    };
  }

  if (candidate.provider === "antigravity") {
    const effort = CLAUDE_EFFORT_MAP[candidate.effort] ?? DEFAULT_EFFORT;
    const settingsPath = NodePath.join(workDir, "agy-settings.json");
    NodeFS.writeFileSync(settingsPath, JSON.stringify({ mcpServers: {} }), "utf8");
    const args = ["--print"];
    if (candidate.model) args.push("--model", candidate.model);
    args.push(
      "--effort",
      effort,
      "--mode",
      "plan",
      "--sandbox",
      "--settings",
      settingsPath,
      "--output-format",
      "stream-json",
      "--json-schema",
      schemaPath,
      "--disable-slash-commands",
    );
    return {
      command: binary,
      args,
      stdinText: prompt,
      resolvedModel: candidate.model || "antigravity",
      resolvedEffort: effort,
    };
  }

  if (candidate.provider === "grok") {
    const effort = GROK_EFFORT_MAP[candidate.effort] ?? DEFAULT_EFFORT;
    const promptFile = NodePath.join(workDir, "prompt.txt");
    NodeFS.writeFileSync(
      promptFile,
      `${prompt}\n\nRespond with ONLY a single JSON object matching this schema:\n${schemaJson}\n`,
      "utf8",
    );
    const args = ["--single"];
    if (candidate.model) args.push("--model", candidate.model);
    args.push(
      "--reasoning-effort",
      effort,
      "--permission-mode",
      "plan",
      "--output-format",
      "streaming-json",
      "--sandbox",
      "read-only",
      "--disallowed-tools",
      "Bash,Write,Edit,WebFetch,WebSearch",
      "--no-memory",
      "--no-subagents",
      "--disable-web-search",
      "--cwd",
      cwd,
      "--prompt-file",
      promptFile,
    );
    return {
      command: binary,
      args,
      stdinText: "",
      resolvedModel: candidate.model || "grok",
      resolvedEffort: effort,
    };
  }

  throw new Error(`unsupported challenge provider: ${candidate.provider}`);
}
