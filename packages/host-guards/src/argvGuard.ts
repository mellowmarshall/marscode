// @effect-diagnostics nodeBuiltinImport:off - Command-line secret detection composing with @t3tools/guard-protocol redaction.
import * as NodePath from "node:path";
import { redactArgvCommand } from "@t3tools/guard-protocol/redaction";

const ARGV_PROGRAMS = new Set(["curl", "wget", "http", "https", "xh"]);
const SECRET_NAME =
  "(?:access[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|client[_-]?secret)";
const AUTH_HEADER_RE = /^\s*(?:--header=)?\s*(?:proxy-)?authorization\s*[:=]/i;
const BEARER_RE = /\bbearer\s+\S/i;
const QUERY_SECRET_RE = new RegExp(`[?&;]${SECRET_NAME}=[^&\\s]`, "i");
const URL_USERINFO_RE = /[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@/i;
const ASSIGNED_SECRET_RE = new RegExp(`\\b[A-Z0-9_]*${SECRET_NAME}[A-Z0-9_]*=\\S`, "i");

const TOKEN_OPTS = new Set([
  "--token",
  "--access-token",
  "--oauth2-bearer",
  "--password",
  "--http-password",
  "--proxy-user",
  "--user",
  "-u",
]);

const REMOTE_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  ASSIGNED_SECRET_RE,
  BEARER_RE,
  QUERY_SECRET_RE,
  URL_USERINFO_RE,
  /\b(?:proxy-)?authorization\s*[:=]/i,
  /(?:^|[\s"'])(?:--(?:token|access-token|oauth2-bearer|password|http-password)\b|(?:--(?:proxy-)?user|-u)\b)/i,
];

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

const FIX_ADVICE =
  "Hand the value over a file or stdin instead: curl -H @headers-file, curl --config - <<<'header = ...', " +
  "or the tool's own environment variable (FLY_API_TOKEN).";

function hasRemoteSecret(cmd: string): boolean {
  return REMOTE_SECRET_PATTERNS.some((re) => re.test(cmd));
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

function detectWhy(program: string, args: ReadonlyArray<string>): string | null {
  const flySsh = (program === "fly" || program === "flyctl") && args.includes("ssh");
  if (!ARGV_PROGRAMS.has(program) && !flySsh) return null;

  let skipNext = false;
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const a = args[i]!;
    const nxt = i + 1 < args.length ? args[i + 1]! : "";
    const eqIdx = a.indexOf("=");
    const name = eqIdx === -1 ? a : a.slice(0, eqIdx);
    const hasEq = eqIdx !== -1;
    const value = hasEq ? a.slice(eqIdx + 1) : "";

    if (!afterDoubleDash && a === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (flySsh && !afterDoubleDash) {
      if (a === "--command") {
        if (hasRemoteSecret(nxt)) return "a secret in the remote command";
        skipNext = true;
        continue;
      }
      if (a.startsWith("--command=")) {
        if (hasRemoteSecret(a.slice(10))) return "a secret in the remote command";
        continue;
      }
      if (a === "--user") {
        if (nxt.includes(":")) return "user:password credentials on the command line";
        if (nxt) skipNext = true;
        continue;
      }
      if (a.startsWith("--user=")) {
        if (a.slice(7).includes(":")) return "user:password credentials on the command line";
        continue;
      }
      if (FLY_NON_SECRET_VALUE_LONGS.has(a)) {
        if (nxt) skipNext = true;
        continue;
      }
      if (hasEq && FLY_NON_SECRET_VALUE_LONGS.has(name)) continue;

      const shortHit = scanFlyShortFlag(a, nxt);
      if (shortHit?.kind === "C") {
        if (hasRemoteSecret(shortHit.value)) return "a secret in the remote command";
        if (shortHit.splitPos === a.length && nxt) skipNext = true;
        continue;
      }
      if (shortHit?.kind === "t") {
        if (shortHit.value) return "a token option (`-t`) on the command line";
        continue;
      }
      if (shortHit?.kind === "u") {
        if (shortHit.value.includes(":")) return "user:password credentials on the command line";
        if (shortHit.splitPos === a.length && nxt) skipNext = true;
        continue;
      }
      if (shortHit?.kind === "value") {
        if (shortHit.splitPos === a.length && nxt) skipNext = true;
        continue;
      }
    }

    if (!afterDoubleDash) {
      if ((a === "-H" || a === "--header") && AUTH_HEADER_RE.test(nxt)) {
        return "an Authorization header on the command line";
      }
      if (AUTH_HEADER_RE.test(a) || (a.startsWith("-H") && AUTH_HEADER_RE.test(a.slice(2)))) {
        return "an Authorization header on the command line";
      }
      if (
        TOKEN_OPTS.has(name) &&
        ((hasEq && value.length > 0) || (!hasEq && nxt.length > 0 && !nxt.startsWith("-")))
      ) {
        const credVal = hasEq ? value : nxt;
        if (name === "-u" || name === "--user" || name === "--proxy-user") {
          if (credVal.includes(":")) return "user:password credentials on the command line";
          if (!hasEq && nxt) skipNext = true;
          continue;
        }
        return `a secret option (\`${name}\`) on the command line`;
      }
    }

    if (BEARER_RE.test(a)) return "a Bearer token on the command line";
    if (URL_USERINFO_RE.test(a)) return "URL user:password credentials on the command line";
    if (QUERY_SECRET_RE.test(a)) return "a secret-named query parameter in the URL";
  }
  return null;
}

export interface ArgvGuardDecision {
  readonly verdict: "allow" | "deny";
  readonly reason: string;
  readonly redactedCommand: ReadonlyArray<string>;
}

export function checkArgvSecrets(words: ReadonlyArray<string>): ArgvGuardDecision {
  if (words.length === 0) {
    return { verdict: "allow", reason: "", redactedCommand: [] };
  }
  const program = NodePath.basename(words[0]!);
  const args = words.slice(1);
  const why = detectWhy(program, args);
  const redactedCommand = redactArgvCommand(words);
  if (!why) {
    return { verdict: "allow", reason: "", redactedCommand };
  }
  return {
    verdict: "deny",
    reason:
      `host argv guard: refusing \`${program}\` with ${why} (argv is visible in /proc and shell history).\n` +
      `  ${FIX_ADVICE}`,
    redactedCommand,
  };
}
