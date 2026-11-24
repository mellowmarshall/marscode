// @effect-diagnostics nodeBuiltinImport:off - Fleet host resolution from ci-hosts.json, SSH targets, wrapper scripts, and GPU hints.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface FleetHostDescriptor {
  /** Canonical machine name matching DevDeck's `nodes` map key (e.g. `host-x`, `dev-host-x`). */
  readonly host: string;
  readonly isLocal: boolean;
  /** Lowercase exact host/ssh aliases (e.g. `host-x`, `host-x-wsl`, `dev-host-x`, `host-x`). */
  readonly exactTokens: ReadonlySet<string>;
  /** Lowercase short suffix tokens (e.g. `wsl`, `7a34`) matched only in explicit remote-target slots. */
  readonly shortTokens: ReadonlySet<string>;
  /** Lowercase GPU/hardware hints parsed from `ci-hosts.json` notes (e.g. `rtx 3080`, `3080`). */
  readonly noteHints: ReadonlyArray<string>;
}

interface CachedFleetHosts {
  readonly path: string;
  readonly stamp: string;
  readonly hosts: ReadonlyArray<FleetHostDescriptor>;
}

let cachedFleetHosts: CachedFleetHosts | null = null;

function defaultCiHostsPath(): string {
  const env = (process.env.DEVTOOLS_CI_HOSTS ?? "").trim();
  if (env) return env;
  return NodePath.join(NodeOS.homedir(), "Dev", "devtools", "ship-queue", "ci-hosts.json");
}

function addSuffixToken(target: Set<string>, raw: string): void {
  const parts = raw
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(Boolean);
  const last = parts.at(-1);
  if (last && last.length >= 3 && /^[a-z0-9]+$/.test(last)) {
    target.add(last);
  }
}

function extractNoteHints(note: string | undefined): ReadonlyArray<string> {
  if (!note) return [];
  const hints: string[] = [];
  const lower = note.toLowerCase();
  const gpuRe =
    /\b(?:rtx|gtx|rx|arc|apple)\s+[a-z0-9]+(?:\s+(?:ti|xt|xtx|super|pro|max|ultra))?\b/g;
  for (const match of lower.matchAll(gpuRe)) {
    const full = match[0].trim();
    if (full && !hints.includes(full)) hints.push(full);
    const numMatch = /\b(\d{4}(?:\s+(?:ti|xt|xtx|super))?)\b/.exec(full);
    if (numMatch?.[1] && !hints.includes(numMatch[1])) {
      hints.push(numMatch[1]);
    }
  }
  return hints;
}

export function parseFleetHostsConfig(
  raw: unknown,
  localHostname: string,
): ReadonlyArray<FleetHostDescriptor> {
  const hostsArr =
    raw && typeof raw === "object" && Array.isArray((raw as { hosts?: unknown }).hosts)
      ? (raw as { hosts: ReadonlyArray<Record<string, unknown>> }).hosts
      : [];
  const localLower = localHostname.trim().toLowerCase();
  const byCanonical = new Map<
    string,
    {
      readonly host: string;
      isLocal: boolean;
      readonly exactTokens: Set<string>;
      readonly shortTokens: Set<string>;
      readonly noteHints: Set<string>;
    }
  >();

  for (const entry of hostsArr) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const on = typeof entry.on === "string" ? entry.on.trim() : "";
    const ssh = typeof entry.ssh === "string" ? entry.ssh.trim() : "";
    const note = typeof entry.note === "string" ? entry.note : undefined;
    const canonical = on || name;
    let bucket = byCanonical.get(canonical);
    if (!bucket) {
      bucket = {
        host: canonical,
        isLocal: canonical.toLowerCase() === localLower,
        exactTokens: new Set(),
        shortTokens: new Set(),
        noteHints: new Set(),
      };
      byCanonical.set(canonical, bucket);
    }
    if (name.toLowerCase() === localLower) bucket.isLocal = true;
    for (const candidate of [canonical, name, ssh]) {
      const lower = candidate.toLowerCase();
      if (!lower) continue;
      bucket.exactTokens.add(lower);
      const stripped = lower.replace(/^dev-/, "");
      if (stripped && stripped !== lower) bucket.exactTokens.add(stripped);
      addSuffixToken(bucket.shortTokens, lower);
    }
    for (const hint of extractNoteHints(note)) {
      bucket.noteHints.add(hint);
    }
  }

  return [...byCanonical.values()].map((b) => ({
    host: b.host,
    isLocal: b.isLocal,
    exactTokens: b.exactTokens,
    shortTokens: b.shortTokens,
    noteHints: [...b.noteHints],
  }));
}

export function loadFleetHosts(
  localHostname: string,
  ciHostsPathOverride?: string | null,
): ReadonlyArray<FleetHostDescriptor> {
  if (ciHostsPathOverride === null) return [];
  const filePath = ciHostsPathOverride || defaultCiHostsPath();
  let stamp = "";
  try {
    const st = NodeFS.statSync(filePath);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    return [];
  }
  if (cachedFleetHosts && cachedFleetHosts.path === filePath && cachedFleetHosts.stamp === stamp) {
    return cachedFleetHosts.hosts;
  }
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as unknown;
    const hosts = parseFleetHostsConfig(parsed, localHostname);
    cachedFleetHosts = { path: filePath, stamp, hosts };
    return hosts;
  } catch {
    return [];
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWordToken(haystackLower: string, token: string): boolean {
  if (!token) return false;
  const re = new RegExp(`(?<![a-z0-9_-])${escapeRegExp(token)}(?![a-z0-9_-])`, "i");
  return re.test(haystackLower);
}

const SSH_TARGET_FLAGS_WITH_ARG = new Set(
  "-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w".split(" "),
);

function extractExplicitRemoteTargets(command: string): ReadonlyArray<string> {
  const targets: string[] = [];

  // 1. Direct `ssh [flags...] [user@]<target>`
  const sshRe = /(?:^|[\s;&|()])ssh\s+([^\n;&|]+)/gi;
  for (const m of command.matchAll(sshRe)) {
    const args = (m[1] ?? "").trim().split(/\s+/);
    let i = 0;
    while (i < args.length) {
      const tok = args[i]!;
      if (tok === "--") {
        i += 1;
        break;
      }
      if (tok.startsWith("-")) {
        i += SSH_TARGET_FLAGS_WITH_ARG.has(tok) ? 2 : 1;
        continue;
      }
      const clean = tok.replace(/^["']|["']$/g, "");
      const atIdx = clean.lastIndexOf("@");
      const hostTok = (atIdx >= 0 ? clean.slice(atIdx + 1) : clean).toLowerCase();
      if (hostTok) targets.push(hostTok);
      break;
    }
  }

  // 2. Wrapper scripts: `remote.sh <host>`, `--host <host>`, `--host=<host>`, `HOST=<host>`
  const wrapperRe =
    /(?:(?:^|[\s/])remote\.sh\s+|(?:--host|-H)(?:\s+|=)|(?:^|\s)(?:TARGET_HOST|REMOTE_HOST|SSH_HOST)=)(['"]?)([A-Za-z0-9._-]+)\1/gi;
  for (const m of command.matchAll(wrapperRe)) {
    const tok = (m[2] ?? "").trim().toLowerCase();
    if (tok) targets.push(tok);
  }

  return targets;
}

/**
 * Infers which fleet host executes a command (e.g. `host-x`, `dev-host-x`, `host-x`)
 * from SSH destinations, remote wrapper targets, explicit host aliases, or hardware hints in
 * `ci-hosts.json`. Falls back to `localHostname`.
 */
export function inferTargetHost(
  command: string,
  description: string | undefined,
  localHostname: string,
  fleetHosts: ReadonlyArray<FleetHostDescriptor>,
): string {
  const remoteHosts = fleetHosts.filter((h) => !h.isLocal);
  if (remoteHosts.length === 0) return localHostname;

  // 1. Explicit remote targets (`ssh <target>`, `remote.sh <target>`, `--host <target>`)
  const explicitTargets = extractExplicitRemoteTargets(command);
  for (const tok of explicitTargets) {
    const exactMatch = remoteHosts.find((h) => h.exactTokens.has(tok));
    if (exactMatch) return exactMatch.host;
    const shortMatch = remoteHosts.find((h) => h.shortTokens.has(tok));
    if (shortMatch) return shortMatch.host;
  }

  // 2. Explicit remote host or ssh alias mentioned in the human description only
  //    (never arbitrary paths or comments inside the shell command).
  const descLower = (description ?? "").toLowerCase();
  if (descLower) {
    for (const h of remoteHosts) {
      for (const tok of h.exactTokens) {
        if (tok.length >= 4 && hasWordToken(descLower, tok)) {
          return h.host;
        }
      }
    }

    // 3. Hardware/GPU hint from `ci-hosts.json` notes matched in description (e.g. `on 3080`)
    for (const h of remoteHosts) {
      for (const hint of h.noteHints) {
        if (hasWordToken(descLower, hint)) {
          return h.host;
        }
      }
    }
  }

  return localHostname;
}
