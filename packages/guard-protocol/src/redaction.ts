// @effect-diagnostics nodeBuiltinImport:off - Shared argv secret redaction for guard previews and audit logs (mirrors host-guards/hg_argv.py).
import * as NodePath from "node:path";

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

function redactUrlSecrets(value: string): string {
  ARGV_URL_USERINFO_RE.lastIndex = 0;
  ARGV_QUERY_SECRET_RE.lastIndex = 0;
  return value
    .replace(ARGV_URL_USERINFO_RE, "$1<redacted>@")
    .replace(ARGV_QUERY_SECRET_RE, "$1<redacted>");
}

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

function redactRemoteCommand(): string {
  // Unconditionally redact fly ssh remote command strings in previews and audit logs
  // so no quoted credential flag, whitespace username, or shell trick can ever leak.
  return "<redacted-remote-command>";
}

/**
 * Redact credential-bearing arguments for guard display previews and audit logs.
 * Raw secrets stay strictly ephemeral during SHA-256 verification and never enter stored requests, SSE, or UI.
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
    const nxt = i + 1 < args.length ? args[i + 1]! : "";
    const eqIdx = a.indexOf("=");
    const name = eqIdx === -1 ? a : a.slice(0, eqIdx);
    const hasEq = eqIdx !== -1;
    const value = hasEq ? a.slice(eqIdx + 1) : "";

    if (!afterDoubleDash && a === "--") {
      afterDoubleDash = true;
      out.push(a);
      continue;
    }
    if (flySsh && !afterDoubleDash) {
      if (a === "--command" && nxt) {
        out.push(a, redactRemoteCommand());
        skipNext = true;
        skipMode = "none";
        continue;
      }
      if (a.startsWith("--command=")) {
        out.push(`--command=${redactRemoteCommand()}`);
        continue;
      }
      if (a === "--user") {
        out.push(a);
        if (nxt) {
          skipNext = true;
          skipMode = nxt.includes(":") ? "redacted" : "verbatim";
        }
        continue;
      }
      if (a.startsWith("--user=")) {
        out.push(a.slice(7).includes(":") ? "--user=<redacted>" : a);
        continue;
      }
      if (FLY_NON_SECRET_VALUE_LONGS.has(a)) {
        out.push(a);
        if (nxt) {
          skipNext = true;
          skipMode = "verbatim";
        }
        continue;
      }
      if (hasEq && FLY_NON_SECRET_VALUE_LONGS.has(name)) {
        out.push(a);
        continue;
      }
      const shortHit = scanFlyShortFlag(a, nxt);
      if (shortHit?.kind === "C") {
        if (shortHit.splitPos < a.length) {
          out.push(`${a.slice(0, shortHit.splitPos)}${redactRemoteCommand()}`);
        } else if (nxt) {
          out.push(a, redactRemoteCommand());
          skipNext = true;
          skipMode = "none";
        } else {
          out.push(a);
        }
        continue;
      }
      if (shortHit?.kind === "t") {
        if (shortHit.splitPos < a.length) {
          out.push(`${a.slice(0, shortHit.splitPos)}<redacted>`);
        } else if (nxt) {
          out.push(a);
          skipNext = true;
          skipMode = "redacted";
        } else {
          out.push(a);
        }
        continue;
      }
      if (shortHit?.kind === "u") {
        if (shortHit.value.includes(":")) {
          if (shortHit.splitPos < a.length) {
            out.push(`${a.slice(0, shortHit.splitPos)}<redacted>`);
          } else if (nxt) {
            out.push(a);
            skipNext = true;
            skipMode = "redacted";
          } else {
            out.push(a);
          }
        } else {
          out.push(a);
          if (shortHit.splitPos === a.length && nxt) {
            skipNext = true;
            skipMode = "verbatim";
          }
        }
        continue;
      }
      if (shortHit?.kind === "value") {
        out.push(a);
        if (shortHit.splitPos === a.length && nxt) {
          skipNext = true;
          skipMode = "verbatim";
        }
        continue;
      }
    }
    if (!afterDoubleDash) {
      if ((a === "-H" || a === "--header") && ARGV_AUTH_HEADER_RE.test(nxt)) {
        out.push(a);
        skipNext = true;
        continue;
      }
      if (
        ARGV_AUTH_HEADER_RE.test(a) ||
        (a.startsWith("-H") && ARGV_AUTH_HEADER_RE.test(a.slice(2)))
      ) {
        const prefix = a.toLowerCase().startsWith("--header=")
          ? "--header="
          : a.startsWith("-H")
            ? "-H"
            : "";
        out.push(`${prefix}<redacted-auth-header>`);
        continue;
      }
      if (
        ARGV_TOKEN_OPTS.has(name) &&
        ((hasEq && value) || (!hasEq && nxt && !nxt.startsWith("-")))
      ) {
        const credVal = hasEq ? value : nxt;
        if (
          (name === "-u" || name === "--user" || name === "--proxy-user") &&
          !credVal.includes(":")
        ) {
          out.push(a);
          if (!hasEq && nxt) {
            skipNext = true;
            skipMode = "verbatim";
          }
          continue;
        }
        if (hasEq) {
          out.push(`${name}=<redacted>`);
        } else {
          out.push(a);
          skipNext = true;
        }
        continue;
      }
    }
    let cur = a;
    ARGV_BEARER_RE.lastIndex = 0;
    cur = cur.replace(ARGV_BEARER_RE, "$1<redacted>");
    cur = redactUrlSecrets(cur);
    out.push(cur);
  }
  return out;
}
