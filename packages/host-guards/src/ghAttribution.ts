// @effect-diagnostics nodeBuiltinImport:off - Agent GitHub CLI prose attribution stamping reusing @t3tools/shared/githubAttribution.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { stampAgentProse, type AgentAttributionIdentity } from "@t3tools/shared/githubAttribution";
import { AGENT_THREAD_ENV } from "@t3tools/shared/procIdentity";

import { normalizeApiPath } from "./ghApiGuard.ts";
import {
  expandNonShellGhAliases,
  extractLeadingGhCommands,
  GH_API_OTHER_VALUE_FLAGS,
  GH_HIGH_LEVEL_VALUE_FLAGS,
  inspectGhCommandTarget,
  matchGhValueFlag,
  resolveEnvGhRepoSlug,
  scanGhApiInvocation,
} from "./ghArgParse.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import { resolveCallerIdentity } from "./procIdentity.ts";
import { inspectRepo, isSlugInScope } from "./repoScope.ts";
import { resolveT3ServerPid, resolveT3ThreadId } from "./t3ServerTrust.ts";

const STAMPABLE_ISSUE_SUBS = new Set(["create", "new", "comment", "edit"]);
const STAMPABLE_PR_SUBS = new Set(["create", "new", "comment", "review", "edit"]);
const SKIP_STAMP_FLAGS = new Set(["--fill", "--fill-first", "--fill-verbose", "--web", "-w"]);
const NO_OP = (args: ReadonlyArray<string>): GhStampResult => ({
  args,
  stamped: false,
  tempDirs: [],
  consumedStdin: false,
});

export interface GhStampResult {
  readonly args: ReadonlyArray<string>;
  readonly stamped: boolean;
  readonly tempDirs: ReadonlyArray<string>;
  readonly consumedStdin: boolean;
}

export interface GhStampOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly procFs?: ProcFsReader | undefined;
  readonly socketPath?: string | undefined;
  readonly allowEnvThreadId?: boolean | undefined;
  readonly testMode?: boolean | undefined;
  readonly stdin?: string | undefined;
}

function readStdinSafe(override?: string): string {
  if (override !== undefined) return override;
  try {
    return NodeFS.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readRegularFile(filePath: string, cwd: string): string | null {
  try {
    const abs = NodePath.resolve(cwd, filePath);
    return NodeFS.statSync(abs).isFile() ? NodeFS.readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

function writePrivateTempFile(content: string, filename: string, tempDirs: string[]): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-gh-body-"));
  NodeFS.chmodSync(dir, 0o700);
  const filePath = NodePath.join(dir, filename);
  NodeFS.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  NodeFS.chmodSync(filePath, 0o600);
  tempDirs.push(dir);
  return filePath;
}

export function cleanupGhStampTempDirs(tempDirs: ReadonlyArray<string>): void {
  for (const dir of tempDirs) {
    try {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

function inferAgentDisplayName(env: NodeJS.ProcessEnv): string {
  const explicit = env.MARSCODE_AGENT_NAME?.trim() || env.T3CODE_AGENT_NAME?.trim();
  if (explicit) return explicit;
  if (env.CLAUDECODE?.trim() || env.CLAUDE_CODE?.trim()) return "Claude Code";
  if (env.CODEX_SANDBOX?.trim() || env.CODEX_THREAD_ID?.trim() || env.CODEX_SESSION_ID?.trim()) {
    return "Codex Agent";
  }
  if (env.ANTIGRAVITY_AGENT?.trim()) return "Antigravity Agent";
  if (env.CURSOR_TRACE_ID?.trim()) return "Cursor Agent";
  return "MarsCode Agent";
}

/** Resolves agent attribution identity for `gh`. Returns `null` for human callers. */
function resolveGhAgentIdentity(options?: GhStampOptions): AgentAttributionIdentity | null {
  const env = options?.env ?? process.env;
  const procFs = options?.procFs ?? defaultProcFs;
  const serverPid = resolveT3ServerPid({ procFs, socketPath: options?.socketPath });
  const caller = resolveCallerIdentity({
    env,
    testMode: options?.testMode,
    procFs,
    t3ServerPid: serverPid,
  });
  if (!caller.isAgent) return null;

  const verifiedThread = resolveT3ThreadId(env, {
    procFs,
    socketPath: options?.socketPath,
    allowEnvThreadId: options?.allowEnvThreadId,
  });
  const threadId = verifiedThread || env[AGENT_THREAD_ENV]?.trim() || "";
  const rawSession = caller.sessionId.trim();
  const sessionId =
    rawSession && rawSession !== threadId
      ? rawSession
      : threadId
        ? ""
        : env.CURSOR_TRACE_ID?.trim() || "agent";

  return {
    displayName: inferAgentDisplayName(env),
    ...(sessionId ? { sessionId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function stampHighLevelGhArgs(
  args: ReadonlyArray<string>,
  cmd: string,
  sub: string,
  cwd: string,
  config: HostGuardsConfig,
  identity: AgentAttributionIdentity,
  env: NodeJS.ProcessEnv,
  stdinOverride?: string,
): GhStampResult {
  const { slug } = inspectGhCommandTarget(args, cwd, config, env);
  if (!slug || !isSlugInScope(slug, config)) return NO_OP(args);

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") break;
    const eq = a.startsWith("-") ? a.indexOf("=") : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (
      SKIP_STAMP_FLAGS.has(flag) ||
      (cmd === "pr" && (sub === "create" || sub === "new") && flag === "-f")
    ) {
      return NO_OP(args);
    }
    if (
      eq === -1 &&
      (GH_HIGH_LEVEL_VALUE_FLAGS.has(flag) ||
        flag === "-b" ||
        flag === "--body" ||
        flag === "-F" ||
        flag === "--body-file")
    ) {
      i += 1;
    }
  }

  const out = [...args];
  const tempDirs: string[] = [];
  let stamped = false;
  let consumedStdin = false;

  for (let i = 0; i < out.length; i += 1) {
    const a = out[i]!;
    if (a === "--") break;
    const eq = a.startsWith("-") ? a.indexOf("=") : -1;
    if (GH_HIGH_LEVEL_VALUE_FLAGS.has(eq === -1 ? a : a.slice(0, eq))) {
      if (eq === -1) i += 1;
      continue;
    }
    const bodyMatch = matchGhValueFlag(out, i, "-b", "--body");
    if (bodyMatch) {
      const next = stampAgentProse(bodyMatch.value, identity);
      if (next !== bodyMatch.value) {
        stamped = true;
        bodyMatch.setValue(next);
      }
      i += bodyMatch.step;
      continue;
    }
    const fileMatch = matchGhValueFlag(out, i, "-F", "--body-file");
    if (fileMatch) {
      const content =
        fileMatch.value === "-"
          ? ((consumedStdin = true), readStdinSafe(stdinOverride))
          : readRegularFile(fileMatch.value, cwd);
      if (content !== null) {
        const next = stampAgentProse(content, identity);
        if (next !== content || fileMatch.value === "-") {
          if (next !== content) stamped = true;
          fileMatch.setValue(writePrivateTempFile(next, "body.txt", tempDirs));
        }
      }
      i += fileMatch.step;
    }
  }
  return { args: out, stamped, tempDirs, consumedStdin };
}

function isAllowlistedRestProseEndpoint(method: string, rest: string): boolean {
  if (method === "POST") {
    return (
      rest === "issues" ||
      /^issues\/\d+\/comments$/.test(rest) ||
      rest === "pulls" ||
      /^pulls\/\d+\/comments$/.test(rest) ||
      /^pulls\/\d+\/comments\/\d+\/replies$/.test(rest) ||
      /^pulls\/\d+\/reviews$/.test(rest)
    );
  }
  return (
    method === "PATCH" &&
    (/^issues\/\d+$/.test(rest) ||
      /^issues\/comments\/\d+$/.test(rest) ||
      /^pulls\/\d+$/.test(rest))
  );
}

function stampJsonBodyText(
  rawText: string,
  identity: AgentAttributionIdentity,
): { text: string; changed: boolean } {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.body === "string") {
        const stampedBody = stampAgentProse(obj.body, identity);
        if (stampedBody !== obj.body) {
          return { text: JSON.stringify({ ...obj, body: stampedBody }), changed: true };
        }
      }
    }
  } catch {
    // Leave invalid JSON untouched for `gh` to report.
  }
  return { text: rawText, changed: false };
}

function stampGhApiArgs(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  identity: AgentAttributionIdentity,
  env: NodeJS.ProcessEnv,
  stdinOverride?: string,
): GhStampResult {
  const parsedApi = scanGhApiInvocation(args);
  if (!parsedApi) return NO_OP(args);
  const { apiIdx, endpoint, method: effMethod } = parsedApi;
  const out = [...args];
  const match = /^repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(normalizeApiPath(endpoint));
  if (!match?.[1] || !match[2] || !match[3]) return NO_OP(args);

  const envSlug = resolveEnvGhRepoSlug(env);
  const here = envSlug ? null : inspectRepo(cwd, config, env);
  const fallbackSlug = envSlug
    ? envSlug.split("/")
    : here && here.inScope
      ? here.slug.split("/")
      : null;
  let owner = match[1].toLowerCase();
  let name = match[2].toLowerCase();
  const rest = match[3].replace(/\/+$/, "");
  if (owner === "{owner}" || owner === ":owner") owner = fallbackSlug?.[0] ?? "";
  if (name === "{repo}" || name === ":repo") name = fallbackSlug?.[1] ?? "";
  if (
    !owner ||
    !name ||
    !isSlugInScope(owner, config, name) ||
    !isAllowlistedRestProseEndpoint(effMethod, rest)
  ) {
    return NO_OP(args);
  }

  const tempDirs: string[] = [];
  let stamped = false;
  let consumedStdin = false;

  for (let i = 0; i < out.length; i += 1) {
    if (i === apiIdx) continue;
    const a = out[i]!;
    if (a === "--") break;
    const eq = a.startsWith("-") ? a.indexOf("=") : -1;
    if (GH_API_OTHER_VALUE_FLAGS.has(eq === -1 ? a : a.slice(0, eq))) {
      if (eq === -1) i += 1;
      continue;
    }
    const inputMatch = matchGhValueFlag(out, i, null, "--input");
    if (inputMatch) {
      const rawText =
        inputMatch.value === "-"
          ? ((consumedStdin = true), readStdinSafe(stdinOverride))
          : readRegularFile(inputMatch.value, cwd);
      if (rawText !== null) {
        const updated = stampJsonBodyText(rawText, identity);
        if (updated.changed) stamped = true;
        if (updated.changed || inputMatch.value === "-") {
          inputMatch.setValue(writePrivateTempFile(updated.text, "payload.json", tempDirs));
        }
      }
      i += inputMatch.step;
      continue;
    }
    const rawField = matchGhValueFlag(out, i, "-f", "--raw-field");
    const typedField = rawField ? null : matchGhValueFlag(out, i, "-F", "--field");
    const field = rawField ?? typedField;
    if (!field) continue;
    if (field.value.startsWith("body=")) {
      const rawVal = field.value.slice("body=".length);
      if (typedField && rawVal.startsWith("@")) {
        const ref = rawVal.slice(1);
        const content =
          ref === "-"
            ? ((consumedStdin = true), readStdinSafe(stdinOverride))
            : readRegularFile(ref, cwd);
        if (content !== null) {
          const next = stampAgentProse(content, identity);
          if (next !== content || ref === "-") {
            if (next !== content) stamped = true;
            field.setValue(`body=@${writePrivateTempFile(next, "body.txt", tempDirs)}`);
          }
        }
      } else {
        const next = stampAgentProse(rawVal, identity);
        if (next !== rawVal) {
          stamped = true;
          field.setValue(`body=${next}`);
        }
      }
    }
    i += field.step;
  }
  return { args: out, stamped, tempDirs, consumedStdin };
}

/** Rewrites `gh` arguments to stamp agent GitHub prose on in-scope repositories. */
export function prepareStampedGhArgs(
  args: ReadonlyArray<string>,
  cwd: string,
  config: HostGuardsConfig,
  options?: GhStampOptions,
): GhStampResult {
  const identity = resolveGhAgentIdentity(options);
  if (!identity) return NO_OP(args);
  const env = options?.env ?? process.env;
  const expanded = expandNonShellGhAliases(args, cwd, config);
  const effectiveArgs = expanded ?? args;

  const words = extractLeadingGhCommands(effectiveArgs);
  let res: GhStampResult = NO_OP(effectiveArgs);
  if (words[0] === "api") {
    res = stampGhApiArgs(effectiveArgs, cwd, config, identity, env, options?.stdin);
  } else if (
    (words[0] === "issue" && words[1] && STAMPABLE_ISSUE_SUBS.has(words[1])) ||
    (words[0] === "pr" && words[1] && STAMPABLE_PR_SUBS.has(words[1]))
  ) {
    res = stampHighLevelGhArgs(
      effectiveArgs,
      words[0],
      words[1],
      cwd,
      config,
      identity,
      env,
      options?.stdin,
    );
  }
  return res.stamped || res.tempDirs.length > 0 ? res : NO_OP(args);
}
