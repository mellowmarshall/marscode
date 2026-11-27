/**
 * PLAYBOOK §16 generic rules. Each is an allowlist of neutral values, so an unknown name fails;
 * the owner's real strings never appear here (they live only in the host-local denylist).
 */
import type { HygieneClass, HygieneSurface } from "./hygieneCatalog.ts";
import type { HygienePolicy } from "./hygieneTypes.ts";
import { isNeutralAgentTrailer, isOpaqueAgentId, NEUTRAL_AGENT_NAME } from "./identity.ts";

/** Synthetic user names in fixtures, documentation, and standard system accounts. */
const NEUTRAL_HOME_NAMES = new Set([
  "a",
  "ada",
  "admin",
  "al",
  "alice",
  "b",
  "bob",
  "box",
  "ci",
  "demo",
  "deploy",
  "dev",
  "developer",
  "expo",
  "fx",
  "fx-replay",
  "grok-replay",
  "jane",
  "kiro-replay",
  "linuxbrew",
  "local",
  "logs",
  "maria",
  "me",
  "my",
  "o",
  "ops",
  "other",
  "private",
  "replay-user",
  "runner",
  "server",
  "settings.json",
  "someone",
  "t3",
  "test",
  "tester",
  "testuser",
  "u",
  "ubuntu",
  "user",
  "vscode",
  "x",
  "zen-user",
]);

/** Tailnet labels that upstream fixtures already use as generic examples. */
const TAILNET_PLACEHOLDERS = new Set([
  "example",
  "other-tail",
  "tail",
  "tail1234",
  "tail9f3a",
  "tailnet",
  "tailnet-name",
]);

/** Public forges whose SSH endpoints are services, not machines. */
const PUBLIC_SSH_HOSTS = new Set([
  "altssh.bitbucket.org",
  "aur.archlinux.org",
  "bitbucket.org",
  "codeberg.org",
  "github.com",
  "gitlab.com",
  "ssh.dev.azure.com",
]);

const GENERIC_SSH_HOSTS = new Set(["host", "hostname", "localhost", "remote", "server"]);

/** Android system paths under `/data` that `file://` fixtures legitimately use. */
const NEUTRAL_DATA_ROOTS = new Set(["data", "local", "user"]);

/** The `/data/Dev` root is a public default in shipped code; only names under it can leak. */
const NEUTRAL_DATA_DEV_NAMES = new Set([".ship-queue", "marscode", "proj", "repo", "tools"]);

function isNeutralDataDevName(raw: string): boolean {
  const name = raw.toLowerCase();
  return (
    NEUTRAL_DATA_DEV_NAMES.has(name) ||
    /^(?:project-[a-z]|(?:example|sample)-[a-z0-9-]+)$/.test(name)
  );
}

const DOC_IPV4 = /^(?:192\.0\.2|198\.51\.100|203\.0\.113|127\.0\.0)\.\d{1,3}$/;

export interface PublicRule {
  readonly id: string;
  readonly classId: HygieneClass;
  /** Surfaces the rule runs on; omitted means every text surface. */
  readonly surfaces?: ReadonlyArray<HygieneSurface> | undefined;
  /** Substrings a line must contain before the regex runs (a cheap prefilter). */
  readonly hints?: ReadonlyArray<string> | undefined;
  readonly pattern: RegExp;
  /** Whether this match in `line` is a finding (true) or an allowed neutral value (false). */
  readonly flags: (match: RegExpExecArray, policy: HygienePolicy, line: string) => boolean;
}

function isNeutralHomeName(raw: string, policy: HygienePolicy): boolean {
  const name = raw.replace(/\.+$/, "").toLowerCase();
  if (!name || name.startsWith(".")) return true;
  if (NEUTRAL_HOME_NAMES.has(name)) return true;
  return policy.upstreamNames.some((entry) => entry.name.toLowerCase() === name);
}

export function isPlaceholderHost(raw: string): boolean {
  const host = raw.replace(/\.+$/, "").toLowerCase();
  if (GENERIC_SSH_HOSTS.has(host) || PUBLIC_SSH_HOSTS.has(host)) return true;
  if (DOC_IPV4.test(host)) return true;
  const labels = host.split(".");
  if (labels[0] === "example") return true;
  if (/^host-[a-z](?:-[a-z0-9]+)?$/.test(labels[0] ?? "") && labels.length === 1) return true;
  const tld = labels.at(-1) ?? "";
  if (labels.length > 1 && ["test", "invalid", "example", "localhost"].includes(tld)) return true;
  return labels.length > 1 && labels.at(-2) === "example";
}

/** A template interpolation (`${id}`) in code that builds the line, not a concrete value. */
const TEMPLATE_TOKEN = /^\$\{[^}]+\}$/;

/** An `agents.local` mailbox in a `Key: Name <uuid@agents.local>` trailer with the neutral name. */
function isNeutralAgentMailbox(m: RegExpExecArray, line: string): boolean {
  // A bare mention of the domain names no thread.
  if (!m[1] && !m[2]) return true;
  if (m[1] !== "<" || m[3] !== ">") return false;
  const before = line.slice(0, m.index).trimEnd();
  const name = before.slice(before.lastIndexOf(":") + 1).replace(/^["'`\s]+/, "");
  const local = m[2] ?? "";
  if (TEMPLATE_TOKEN.test(local)) return name === NEUTRAL_AGENT_NAME;
  return isNeutralAgentTrailer(name, `${local}@agents.local`);
}

/** The value after `Agent Session:` / `Agent Thread:` is one opaque id with nothing after it. */
function isOpaqueAgentLine(m: RegExpExecArray): boolean {
  const value = m[1] ?? "";
  const opaque = isOpaqueAgentId(value) || TEMPLATE_TOKEN.test(value);
  return opaque && /^(?:\s*$|["'`\\])/.test(m[2] ?? "");
}

export function isPlaceholderTailnetName(fqdn: string): boolean {
  const labels = fqdn
    .toLowerCase()
    .replace(/\.ts\.net$/, "")
    .split(".");
  if (labels.length < 2) return true;
  return TAILNET_PLACEHOLDERS.has(labels.at(-1) ?? "");
}

const PATH_START = String.raw`(?<![A-Za-z0-9_.~/-])`;

export const PUBLIC_RULES: ReadonlyArray<PublicRule> = [
  {
    id: "home-paths",
    classId: "home-paths",
    hints: ["/home/", "/Users/"],
    pattern: new RegExp(`${PATH_START}/(?:home|Users)/([A-Za-z0-9._-]+)`, "g"),
    flags: (m, policy) => !isNeutralHomeName(m[1] ?? "", policy),
  },
  {
    id: "data-dev-root",
    classId: "data-layout",
    hints: ["/data/Dev/"],
    pattern: new RegExp(`${PATH_START}/data/Dev/([A-Za-z0-9._-]+)`, "g"),
    flags: (m) => !isNeutralDataDevName(m[1] ?? ""),
  },
  {
    id: "data-backup-root",
    classId: "data-layout",
    hints: ["-backup"],
    pattern: new RegExp(`${PATH_START}/data/[A-Za-z0-9._-]+-backup(?![A-Za-z0-9_-])`, "g"),
    flags: () => true,
  },
  {
    id: "file-url",
    classId: "data-layout",
    hints: ["file:///"],
    pattern: /file:\/\/\/(home|Users|data)\/([A-Za-z0-9._-]+)/g,
    flags: (m, policy) =>
      m[1] === "data"
        ? !NEUTRAL_DATA_ROOTS.has(m[2] ?? "")
        : !isNeutralHomeName(m[2] ?? "", policy),
  },
  {
    id: "ssh-target",
    classId: "ssh-targets",
    hints: ["ssh"],
    pattern:
      /(?<![\w./-])ssh(?:\s+-[A-Za-z]+(?:\s+(?![-\w.]*@)[^\s@]+)?)*\s+[A-Za-z0-9._-]+@([A-Za-z0-9][A-Za-z0-9._-]*)/g,
    flags: (m) => !isPlaceholderHost(m[1] ?? ""),
  },
  {
    id: "tailnet-host",
    classId: "network-identity",
    hints: ["ts.net"],
    pattern: /(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)+ts\.net(?![A-Za-z0-9-])/g,
    flags: (m) => !isPlaceholderTailnetName(m[0]),
  },
  {
    id: "agents-local",
    classId: "agent-session-ids",
    hints: ["@agents.local"],
    pattern: /(<)?([^<>\s@"'`]*)@agents\.local(?![A-Za-z0-9-])(>)?/g,
    flags: (m, _policy, line) => !isNeutralAgentMailbox(m, line),
  },
  {
    id: "agent-session-line",
    classId: "agent-session-ids",
    hints: ["Agent Session:", "Agent Thread:"],
    pattern: /Agent (?:Session|Thread):[ \t]*([^\s"'`\\]*)(.*)$/g,
    flags: (m) => !isOpaqueAgentLine(m),
  },
  {
    id: "host-load",
    classId: "operational-telemetry",
    surfaces: ["github-text"],
    pattern: /\bload(?:1|5|15)\s*[=:]\s*\d|\bloadavg\b|\bload average:\s*\d/gi,
    flags: () => true,
  },
  {
    id: "job-id",
    classId: "operational-telemetry",
    surfaces: ["github-text"],
    pattern: /\bjob[=#]\d{4,16}\b/gi,
    flags: () => true,
  },
  {
    id: "cost-total",
    classId: "operational-telemetry",
    surfaces: ["github-text"],
    pattern: /(?<![\w$])\$\d{1,6}\.\d{2}(?!\d)/g,
    flags: () => true,
  },
  {
    id: "token-total",
    classId: "operational-telemetry",
    surfaces: ["github-text"],
    pattern:
      /\b(?:\d+(?:\.\d+)?\s?[kKmMbB]|\d{1,3}(?:,\d{3})+|\d{5,})\s+(?:input |output |cached )?tokens\b/g,
    flags: () => true,
  },
];

export function rulesFor(surface: HygieneSurface): ReadonlyArray<PublicRule> {
  return PUBLIC_RULES.filter((rule) => !rule.surfaces || rule.surfaces.includes(surface));
}
