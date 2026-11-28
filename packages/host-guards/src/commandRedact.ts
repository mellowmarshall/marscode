// @effect-diagnostics nodeBuiltinImport:off - Universal command-line secret redaction across all host guards (logs and approval modals).
import * as NodePath from "node:path";
import { redactArgvCommand } from "@t3tools/guard-protocol/redaction";

const SECRET_KEY_RE =
  /(?:secret|token|passw|credential|private_?key|api_?key|apikey|database_?url|dsn|bearer|auth(?!or(?:$|[_-]))|_key$|(?:^|_)pat(?:_|$))/i;
const AUTH_HEADER_RE = /^\s*(?:--header=)?\s*(?:proxy-)?authorization\s*[:=]/i;
const EXTRA_HEADER_CONFIG_RE = /^(-c)?([^=\s]*extraheader)=[\s\S]+$/i;
const CREDENTIAL_HELPER_CONFIG_RE = /^(-c)?(credential\.(?:[^=\s]*\.)?helper)=[\s\S]+$/i;
const SECRET_FLAG_EQ_RE =
  /^(--[^=\s]*(?:secret|token|passw|api[-_]?key|apikey|bearer|_auth|auth[-_]?token))=[\s\S]+$/i;
const NPM_REGISTRY_CRED_ASSIGN_RE = /^([^=\s]*:_(?:authToken|auth|password))=[\s\S]+$/i;
const NPM_REGISTRY_CRED_KEY_RE = /(?:^|:)_(?:authToken|auth|password)$/i;
const CREDENTIAL_HELPER_KEY_RE = /^credential\.(?:[^=\s]*\.)?helper$/i;
const BEARER_RE = /(\bbearer\s+)\S+/gi;
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi;
const QUERY_SECRET_RE =
  /([?&;](?:access[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|client[_-]?secret)=)[^&\s]+/gi;
const SECRET_VALUE_FLAGS = new Set([
  "--token",
  "--access-token",
  "--oauth2-bearer",
  "--password",
  "--http-password",
  "--proxy-user",
  "--secret",
  "--api-key",
]);
const FLY_BINS = new Set(["fly", "flyctl"]);
const LOGIN_BINS = new Set(["docker", "podman", "nerdctl", "crane", "helm"]);
const MYSQL_BINS = new Set(["mysql", "mariadb", "mysqldump", "mysqladmin"]);

function redactGenericToken(tok: string): string {
  const configCred = EXTRA_HEADER_CONFIG_RE.exec(tok) ?? CREDENTIAL_HELPER_CONFIG_RE.exec(tok);
  if (configCred) {
    return `${configCred[1] ?? ""}${configCred[2]!}=<redacted>`;
  }
  const secretFlagEq = SECRET_FLAG_EQ_RE.exec(tok);
  if (secretFlagEq) {
    return `${secretFlagEq[1]!}=<redacted>`;
  }
  const npmAuthAssign = NPM_REGISTRY_CRED_ASSIGN_RE.exec(tok);
  if (npmAuthAssign) {
    return `${npmAuthAssign[1]!}=<redacted>`;
  }

  BEARER_RE.lastIndex = 0;
  URL_USERINFO_RE.lastIndex = 0;
  QUERY_SECRET_RE.lastIndex = 0;
  let cur = tok
    .replace(BEARER_RE, "$1<redacted>")
    .replace(URL_USERINFO_RE, "$1<redacted>@")
    .replace(QUERY_SECRET_RE, "$1<redacted>");

  const eq = cur.indexOf("=");
  if (eq > 0 && !cur.startsWith("-")) {
    const key = cur.slice(0, eq);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && SECRET_KEY_RE.test(key)) {
      cur = `${key}=<redacted>`;
    }
  }
  return cur;
}

function redactFlySecretsArgs(words: ReadonlyArray<string>): ReadonlyArray<string> {
  const out: string[] = [words[0]!];
  let seenSecrets = false;
  let inSetOrImport = false;
  let skipValue = false;
  const flyValueFlags = new Set(["-a", "--app", "-c", "--config", "-o", "--org"]);

  for (let i = 1; i < words.length; i += 1) {
    const a = words[i]!;
    if (skipValue) {
      out.push(a);
      skipValue = false;
      continue;
    }
    if (a === "-t" || a === "--access-token") {
      out.push(a);
      if (i + 1 < words.length) {
        out.push("<redacted>");
        i += 1;
      }
      continue;
    }
    if (a.startsWith("--access-token=")) {
      out.push("--access-token=<redacted>");
      continue;
    }
    if (flyValueFlags.has(a)) {
      out.push(a);
      skipValue = true;
      continue;
    }
    if (a.startsWith("-")) {
      out.push(redactGenericToken(a));
      continue;
    }
    if (!seenSecrets && a.toLowerCase() === "secrets") {
      seenSecrets = true;
      out.push(a);
      continue;
    }
    if (seenSecrets && !inSetOrImport) {
      if (a.toLowerCase() === "set" || a.toLowerCase() === "import") {
        inSetOrImport = true;
      }
      out.push(a);
      continue;
    }
    if (inSetOrImport) {
      const eq = a.indexOf("=");
      out.push(eq > 0 ? `${a.slice(0, eq)}=<redacted>` : "<redacted>");
      continue;
    }
    out.push(redactGenericToken(a));
  }
  return out;
}

function redactDopplerSecretsArgs(words: ReadonlyArray<string>): ReadonlyArray<string> {
  const out: string[] = [words[0]!];
  let seenSecrets = false;
  let inSet = false;
  let positionalAfterSet = 0;
  let skipValue = false;
  const dopplerValueFlags = new Set(["-p", "--project", "-c", "--config"]);

  for (let i = 1; i < words.length; i += 1) {
    const a = words[i]!;
    if (skipValue) {
      out.push(a);
      skipValue = false;
      continue;
    }
    if (a === "--token") {
      out.push(a);
      if (i + 1 < words.length) {
        out.push("<redacted>");
        i += 1;
      }
      continue;
    }
    if (a.startsWith("--token=")) {
      out.push("--token=<redacted>");
      continue;
    }
    if (dopplerValueFlags.has(a)) {
      out.push(a);
      skipValue = true;
      continue;
    }
    if (a.startsWith("-")) {
      out.push(redactGenericToken(a));
      continue;
    }
    if (!seenSecrets && a.toLowerCase() === "secrets") {
      seenSecrets = true;
      out.push(a);
      continue;
    }
    if (seenSecrets && !inSet) {
      if (a.toLowerCase() === "set") inSet = true;
      out.push(a);
      continue;
    }
    if (inSet) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out.push(`${a.slice(0, eq)}=<redacted>`);
      } else {
        // `doppler secrets set KEY VALUE` alternates key and value positionals.
        out.push(positionalAfterSet % 2 === 0 ? a : "<redacted>");
        positionalAfterSet += 1;
      }
      continue;
    }
    out.push(redactGenericToken(a));
  }
  return out;
}

/**
 * Redacts credentials across ALL guards before writing `refusals.jsonl`, `overrides.log`,
 * or sending command arrays to `GuardGrantBroker` / approval modals.
 */
export function redactGuardCommand(words: ReadonlyArray<string>): ReadonlyArray<string> {
  if (words.length === 0) return [];
  const base = NodePath.basename(words[0]!).toLowerCase();
  if (FLY_BINS.has(base) && words.some((w) => w.toLowerCase() === "secrets")) {
    return redactFlySecretsArgs(words);
  }
  if (base === "doppler" && words.some((w) => w.toLowerCase() === "secrets")) {
    return redactDopplerSecretsArgs(words);
  }

  const stage1 = redactArgvCommand(words);
  const out: string[] = [stage1[0]!];
  const isGhSecret = base === "gh" && words.some((w) => w.toLowerCase() === "secret");
  const isRegistryLogin = LOGIN_BINS.has(base) && words.some((w) => w.toLowerCase() === "login");
  const isMysql = MYSQL_BINS.has(base);
  let redactNext = false;

  for (let i = 1; i < stage1.length; i += 1) {
    const a = stage1[i]!;
    if (redactNext) {
      out.push("<redacted>");
      redactNext = false;
      continue;
    }
    const nxt = i + 1 < stage1.length ? stage1[i + 1]! : "";
    if (a === "-c" && EXTRA_HEADER_CONFIG_RE.test(nxt)) {
      const m = EXTRA_HEADER_CONFIG_RE.exec(nxt)!;
      out.push(a, `${m[1] ?? ""}${m[2]!}=<redacted>`);
      i += 1;
      continue;
    }
    if (isGhSecret) {
      if (a === "-b" || a === "--body") {
        out.push(a);
        if (i + 1 < stage1.length) redactNext = true;
        continue;
      }
      if (a.startsWith("--body=")) {
        out.push("--body=<redacted>");
        continue;
      }
      if (a.startsWith("-b") && a.length > 2) {
        out.push("-b<redacted>");
        continue;
      }
    }
    if (isRegistryLogin) {
      if (a === "-p" || a === "--password") {
        out.push(a);
        if (i + 1 < stage1.length) redactNext = true;
        continue;
      }
      if (a.startsWith("-p") && !a.startsWith("--") && a.length > 2) {
        out.push("-p<redacted>");
        continue;
      }
    }
    if (isMysql && a.startsWith("-p") && !a.startsWith("--") && a.length > 2) {
      out.push("-p<redacted>");
      continue;
    }
    if (NPM_REGISTRY_CRED_KEY_RE.test(a) || CREDENTIAL_HELPER_KEY_RE.test(a)) {
      out.push(a);
      if (i + 1 < stage1.length) redactNext = true;
      continue;
    }
    if ((a === "-H" || a === "--header") && AUTH_HEADER_RE.test(nxt)) {
      out.push(a);
      redactNext = true;
      continue;
    }
    if (AUTH_HEADER_RE.test(a) || (a.startsWith("-H") && AUTH_HEADER_RE.test(a.slice(2)))) {
      const prefix = a.toLowerCase().startsWith("--header=")
        ? "--header="
        : a.startsWith("-H")
          ? "-H"
          : "";
      out.push(`${prefix}<redacted-auth-header>`);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (SECRET_VALUE_FLAGS.has(flag)) {
      if (eq !== -1) {
        out.push(`${flag}=<redacted>`);
      } else {
        out.push(a);
        if (i + 1 < stage1.length) redactNext = true;
      }
      continue;
    }
    out.push(redactGenericToken(a));
  }
  return out;
}
