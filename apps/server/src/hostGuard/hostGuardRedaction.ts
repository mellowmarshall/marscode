// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing and realpath normalization for host-guard commands.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { PendingHostGuardRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MAX_ARGS = 256;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;
const GUARD_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

const ARGV_PROGRAMS = new Set(["curl", "wget", "http", "https", "xh"]);
const ARGV_TOKEN_OPTS = new Set([
  "--token",
  "--access-token",
  "--oauth2-bearer",
  "--password",
  "--http-password",
  "--proxy-user",
  "--user",
  "-u",
]);
const ARGV_SECRET_NAME =
  "(?:access[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|client[_-]?secret)";
const ARGV_AUTH_HEADER_RE = /^\s*(?:--header=)?\s*(?:proxy-)?authorization\s*[:=]/i;
const ARGV_BEARER_RE = /(\bbearer\s+)\S+/gi;
const ARGV_URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi;
const ARGV_QUERY_SECRET_RE = new RegExp(`([?&;]${ARGV_SECRET_NAME}=)[^&\\s]+`, "gi");

const FLY_NON_SECRET_VALUE_SHORTS = new Set(["a", "c", "o", "r", "A", "g"]);
const FLY_NON_SECRET_VALUE_LONGS = new Set([
  "--address",
  "--app",
  "--config",
  "--container",
  "--group",
  "--hours",
  "--machine",
  "--org",
  "--process-group",
  "--region",
]);
const REMOTE_COMMAND_PLACEHOLDER = "<redacted-remote-command>";

export function sanitizeHostGuardText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  // Strip C0 controls and Unicode bidi overrides to prevent UI/log spoofing.
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

export function argvSha256(command: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(command.join("\0"), "utf8").digest("hex");
}

export function canonicalCwd(cwd: string): string {
  if (!cwd) return "";
  try {
    return NodeFS.realpathSync(cwd);
  } catch {
    return NodePath.resolve(cwd);
  }
}

export function grantKey(guard: string, digest: string, cwd: string, threadId = ""): string {
  return `${guard}\0${digest}\0${canonicalCwd(cwd)}\0${threadId}`;
}

function redactUrlSecrets(value: string): string {
  ARGV_URL_USERINFO_RE.lastIndex = 0;
  ARGV_QUERY_SECRET_RE.lastIndex = 0;
  return value
    .replace(ARGV_URL_USERINFO_RE, "$1<redacted>@")
    .replace(ARGV_QUERY_SECRET_RE, "$1<redacted>");
}

function scanFlyShortFlag(
  arg: string,
  nxt: string,
): {
  readonly kind: "C" | "t" | "u" | "value";
  readonly splitPos: number;
  readonly value: string;
} | null {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) return null;
  for (let pos = 1; pos < arg.length; pos += 1) {
    const ch = arg[pos]!;
    if (FLY_NON_SECRET_VALUE_SHORTS.has(ch)) {
      const value = pos + 1 < arg.length ? arg.slice(pos + 1) : nxt;
      return { kind: "value", splitPos: pos + 1, value };
    }
    if (ch === "C" || ch === "t" || ch === "u") {
      const value = pos + 1 < arg.length ? arg.slice(pos + 1) : nxt;
      return { kind: ch, splitPos: pos + 1, value };
    }
    if (!/[A-Za-z]/.test(ch)) return null;
  }
  return null;
}

type ArgRedactionStep = {
  readonly pushed: ReadonlyArray<string>;
  readonly skipNext: boolean;
  readonly skipMode: "redacted" | "none" | "verbatim";
};

function redactFlySshFlag(arg: string, nxt: string): ArgRedactionStep | null {
  if (arg === "--command" && nxt) {
    return { pushed: [arg, REMOTE_COMMAND_PLACEHOLDER], skipNext: true, skipMode: "none" };
  }
  if (arg.startsWith("--command=")) {
    return {
      pushed: [`--command=${REMOTE_COMMAND_PLACEHOLDER}`],
      skipNext: false,
      skipMode: "none",
    };
  }
  if (arg === "--user") {
    return nxt
      ? {
          pushed: [arg],
          skipNext: true,
          skipMode: nxt.includes(":") ? "redacted" : "verbatim",
        }
      : { pushed: [arg], skipNext: false, skipMode: "none" };
  }
  if (arg.startsWith("--user=")) {
    return {
      pushed: [arg.slice(7).includes(":") ? "--user=<redacted>" : arg],
      skipNext: false,
      skipMode: "none",
    };
  }
  const eqIdx = arg.indexOf("=");
  const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
  if (FLY_NON_SECRET_VALUE_LONGS.has(arg)) {
    return { pushed: [arg], skipNext: Boolean(nxt), skipMode: "verbatim" };
  }
  if (eqIdx !== -1 && FLY_NON_SECRET_VALUE_LONGS.has(name)) {
    return { pushed: [arg], skipNext: false, skipMode: "none" };
  }
  const shortHit = scanFlyShortFlag(arg, nxt);
  if (!shortHit) return null;

  if (shortHit.kind === "C" || shortHit.kind === "t") {
    const replacement = shortHit.kind === "C" ? REMOTE_COMMAND_PLACEHOLDER : "<redacted>";
    if (shortHit.splitPos < arg.length) {
      return {
        pushed: [`${arg.slice(0, shortHit.splitPos)}${replacement}`],
        skipNext: false,
        skipMode: "none",
      };
    }
    if (nxt) {
      return {
        pushed: shortHit.kind === "C" ? [arg, replacement] : [arg],
        skipNext: true,
        skipMode: shortHit.kind === "C" ? "none" : "redacted",
      };
    }
    return { pushed: [arg], skipNext: false, skipMode: "none" };
  }
  if (shortHit.kind === "u") {
    if (shortHit.value.includes(":")) {
      if (shortHit.splitPos < arg.length) {
        return {
          pushed: [`${arg.slice(0, shortHit.splitPos)}<redacted>`],
          skipNext: false,
          skipMode: "none",
        };
      }
      return { pushed: [arg], skipNext: Boolean(nxt), skipMode: "redacted" };
    }
    return {
      pushed: [arg],
      skipNext: shortHit.splitPos === arg.length && Boolean(nxt),
      skipMode: "verbatim",
    };
  }
  return {
    pushed: [arg],
    skipNext: shortHit.splitPos === arg.length && Boolean(nxt),
    skipMode: "verbatim",
  };
}

function redactHttpAuthFlag(arg: string, nxt: string): ArgRedactionStep | null {
  if ((arg === "-H" || arg === "--header") && ARGV_AUTH_HEADER_RE.test(nxt)) {
    return { pushed: [arg], skipNext: true, skipMode: "redacted" };
  }
  if (
    ARGV_AUTH_HEADER_RE.test(arg) ||
    (arg.startsWith("-H") && ARGV_AUTH_HEADER_RE.test(arg.slice(2)))
  ) {
    const prefix = arg.toLowerCase().startsWith("--header=")
      ? "--header="
      : arg.startsWith("-H")
        ? "-H"
        : "";
    return { pushed: [`${prefix}<redacted-auth-header>`], skipNext: false, skipMode: "none" };
  }
  const eqIdx = arg.indexOf("=");
  const hasEq = eqIdx !== -1;
  const name = hasEq ? arg.slice(0, eqIdx) : arg;
  const value = hasEq ? arg.slice(eqIdx + 1) : "";
  if (ARGV_TOKEN_OPTS.has(name) && ((hasEq && value) || (!hasEq && nxt && !nxt.startsWith("-")))) {
    const credVal = hasEq ? value : nxt;
    if ((name === "-u" || name === "--user" || name === "--proxy-user") && !credVal.includes(":")) {
      return { pushed: [arg], skipNext: !hasEq && Boolean(nxt), skipMode: "verbatim" };
    }
    return hasEq
      ? { pushed: [`${name}=<redacted>`], skipNext: false, skipMode: "none" }
      : { pushed: [arg], skipNext: true, skipMode: "redacted" };
  }
  return null;
}

/**
 * Redacts HTTP credentials and `fly ssh` secrets from `argv` preview arrays before storage or
 * RPC broadcast. Raw secrets stay strictly ephemeral for SHA-256 verification.
 */
export function redactArgvCommand(words: ReadonlyArray<string>): ReadonlyArray<string> {
  if (words.length === 0) return [];
  const program = NodePath.basename(words[0]!);
  const args = words.slice(1);
  const flySsh = (program === "fly" || program === "flyctl") && args.includes("ssh");
  if (!ARGV_PROGRAMS.has(program) && !flySsh) {
    return [...words];
  }
  const out: string[] = [words[0]!];
  let skipNext = false;
  let skipMode: "redacted" | "none" | "verbatim" = "redacted";
  let afterDoubleDash = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (skipNext) {
      if (skipMode === "redacted") out.push("<redacted>");
      else if (skipMode === "verbatim") out.push(a);
      skipNext = false;
      skipMode = "redacted";
      continue;
    }
    if (!afterDoubleDash && a === "--") {
      afterDoubleDash = true;
      out.push(a);
      continue;
    }
    const nxt = i + 1 < args.length ? args[i + 1]! : "";
    if (!afterDoubleDash) {
      const flyStep = flySsh ? redactFlySshFlag(a, nxt) : null;
      if (flyStep) {
        out.push(...flyStep.pushed);
        skipNext = flyStep.skipNext;
        skipMode = flyStep.skipMode;
        continue;
      }
      const httpStep = redactHttpAuthFlag(a, nxt);
      if (httpStep) {
        out.push(...httpStep.pushed);
        skipNext = httpStep.skipNext;
        skipMode = httpStep.skipMode;
        continue;
      }
    }
    ARGV_BEARER_RE.lastIndex = 0;
    const redacted = redactUrlSecrets(a.replace(ARGV_BEARER_RE, "$1<redacted>"));
    out.push(redacted);
  }
  return out;
}

export function validateGuardAndCommand(
  rawGuard: unknown,
  rawCommand: unknown,
  suppliedDigest?: unknown,
):
  | {
      readonly ok: true;
      readonly guard: string;
      readonly displayCommand: ReadonlyArray<string>;
      readonly digest: string;
    }
  | { readonly ok: false; readonly error: string } {
  if (typeof rawGuard !== "string" || !GUARD_NAME_RE.test(rawGuard)) {
    return { ok: false, error: "invalid guard name" };
  }
  if (!Array.isArray(rawCommand) || rawCommand.length === 0) {
    return { ok: false, error: "command must be a non-empty string array" };
  }
  if (rawCommand.length > MAX_ARGS) {
    return { ok: false, error: `command exceeds max ${MAX_ARGS} arguments` };
  }
  const command: string[] = [];
  for (const item of rawCommand) {
    if (typeof item !== "string") {
      return { ok: false, error: "command arguments must be strings" };
    }
    if (item.includes("\0")) {
      return { ok: false, error: "command arguments must not contain NUL bytes" };
    }
    command.push(item);
  }
  // Verify supplied argv_sha256 against the raw command so preview and grant digest cannot diverge.
  const computed = argvSha256(command);
  if (suppliedDigest !== undefined && suppliedDigest !== "") {
    if (
      typeof suppliedDigest !== "string" ||
      !HEX_SHA256_RE.test(suppliedDigest) ||
      suppliedDigest !== computed
    ) {
      return { ok: false, error: "argv_sha256 mismatch" };
    }
  }
  const displayCommand = rawGuard === "argv" ? redactArgvCommand(command) : command;
  return { ok: true, guard: rawGuard, displayCommand, digest: computed };
}

export function buildPendingHostGuardRequest(input: {
  readonly msg: Record<string, unknown>;
  readonly guard: string;
  readonly displayCommand: ReadonlyArray<string>;
  readonly digest: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly peerPid?: number | undefined;
  readonly defaultRequestTimeoutMs: number;
  readonly nowMs: number;
}): { readonly request: PendingHostGuardRequest; readonly timeoutMs: number } {
  const rawTimeoutSec = typeof input.msg.timeout === "number" ? input.msg.timeout : undefined;
  const timeoutMs =
    rawTimeoutSec !== undefined && Number.isFinite(rawTimeoutSec)
      ? Math.max(
          MIN_REQUEST_TIMEOUT_MS,
          Math.min(MAX_REQUEST_TIMEOUT_MS, Math.round(rawTimeoutSec * 1000)),
        )
      : input.defaultRequestTimeoutMs;
  const reportedPid =
    typeof input.msg.pid === "number" && Number.isInteger(input.msg.pid) && input.msg.pid > 0
      ? input.msg.pid
      : 0;
  return {
    timeoutMs,
    request: {
      requestId: `t3r_${NodeCrypto.randomBytes(10).toString("hex")}`,
      guard: input.guard,
      command: input.displayCommand,
      argvSha256: input.digest,
      cwd: input.cwd,
      refusal: sanitizeHostGuardText(input.msg.refusal, 1000),
      proposedReason: sanitizeHostGuardText(input.msg.proposed_reason, 400),
      threadId: input.threadId,
      session: sanitizeHostGuardText(input.msg.session, 128),
      pid: input.peerPid && input.peerPid > 0 ? input.peerPid : reportedPid,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs)),
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs + timeoutMs)),
    },
  };
}
