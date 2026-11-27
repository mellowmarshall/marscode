// @effect-diagnostics nodeBuiltinImport:off - Root command validation, grant formatting, and needs-root planning for CI hosts.
import * as NodeCrypto from "node:crypto";

const WORD_RE = /^[A-Za-z0-9._/:=+~-]+$/;
const HOME_RE = /^\/[A-Za-z0-9._/-]+$/;
const DISTRO_RE = /^[A-Za-z0-9._-]+$/;
const SSH_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const TILDE_RE = /(^|[=:])~\//g;

export const WSL_EXE = "/mnt/c/Windows/System32/wsl.exe";
export const SELF_SUDO_TOKEN = "+sudo";

export interface ToolRootSpec {
  readonly install?: string | null | undefined;
  readonly root?: Readonly<Record<string, string>> | undefined;
}

export interface ProvidePlanItem {
  readonly kind: "user" | "root" | "both" | "none";
  readonly tool: string;
  readonly reason?: string | undefined;
}

export interface RootGrantHostRow {
  readonly host: string;
  readonly ssh: string;
  readonly home: string;
  readonly os: string;
  readonly tools: ReadonlyArray<string>;
  readonly wsl?: string | undefined;
}

export interface RootGrantHostEntry {
  readonly host: string;
  readonly ssh: string;
  readonly tools: ReadonlyArray<string>;
  readonly wsl?: string | undefined;
  readonly grant: ReadonlyArray<string>;
  readonly local: ReadonlyArray<string>;
}

export interface RootGrantRequest {
  readonly request: string;
  readonly hosts: ReadonlyArray<RootGrantHostEntry>;
}

/** Validates a manifest `root` command; returns an error message or `null` if valid. */
export function validateRootCommand(cmd: unknown): string | null {
  if (typeof cmd !== "string" || cmd.length === 0 || cmd !== cmd.trim() || cmd.includes("  ")) {
    return "is not one line of words separated by single spaces";
  }
  const words = cmd.split(" ");
  for (const w of words) {
    if (!WORD_RE.test(w)) {
      return `word ${JSON.stringify(w)} holds a character outside [A-Za-z0-9._/:=+~-] (a quote, variable, glob or separator)`;
    }
    if (w.startsWith("=") || w === "-" || w === "--") {
      return `word ${JSON.stringify(w)} is read by a shell (zsh's =cmd) or dropped by PowerShell`;
    }
    if (w.replace(TILDE_RE, "$1").includes("~")) {
      return `word ${JSON.stringify(w)} has a ~ that is not ~/ at its start or after = or :`;
    }
  }
  const program = words[0] ?? "";
  if (!program.startsWith("/") && !program.startsWith("~/")) {
    return `its program ${JSON.stringify(program)} is not an absolute path (/... or ~/...)`;
  }
  return null;
}

/** Replaces leading/prefixed `~/` tokens in a validated root command with `home/`. */
export function expandRootCommand(cmd: string, home: string): string {
  if (!HOME_RE.test(home)) {
    throw new Error(
      `the host's home ${JSON.stringify(home)} is not an absolute path of [A-Za-z0-9._/-]`,
    );
  }
  return cmd
    .split(" ")
    .map((w) => w.replace(TILDE_RE, `$1${home}/`))
    .join(" ");
}

/** Merges commands that differ only in their final argument (e.g. `apt-get install -y a` + `... b`). */
export function mergeRootCommands(cmds: ReadonlyArray<string>): ReadonlyArray<string> {
  const merged: string[][] = [];
  for (const c of cmds) {
    const why = validateRootCommand(c);
    if (why || c.includes("~")) {
      throw new Error(
        `root command ${JSON.stringify(c)} ${why ?? "still has a ~/ the queue did not expand"}`,
      );
    }
    const lastSpace = c.lastIndexOf(" ");
    const head = lastSpace >= 0 ? c.slice(0, lastSpace) : "";
    const last = lastSpace >= 0 ? c.slice(lastSpace + 1) : c;
    let found = false;
    if (head) {
      for (const m of merged) {
        if (m[0] === head) {
          if (!m.slice(1).includes(last)) m.push(last);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      merged.push(head ? [head, last] : [c]);
    }
  }
  return merged.map((m) => m.filter(Boolean).join(" "));
}

/** Formats root commands for direct execution on a WSL host or passwordless-sudo Linux guest. */
export function buildWslRootLines(
  distro: string,
  cmds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (distro === SELF_SUDO_TOKEN) {
    return mergeRootCommands(cmds).map((line) => `/usr/bin/sudo -n ${line}`);
  }
  if (!DISTRO_RE.test(distro)) {
    throw new Error(`the WSL distro ${JSON.stringify(distro)} is not a name of [A-Za-z0-9._-]`);
  }
  return mergeRootCommands(cmds).map((line) => `${WSL_EXE} -d ${distro} -u root -e ${line}`);
}

/** Formats owner-run grant commands (with `ssh -t` when `ssh` is non-empty). */
export function buildGrantLines(
  ssh: string,
  cmds: ReadonlyArray<string>,
  wsl = "",
): ReadonlyArray<string> {
  if (ssh && !SSH_RE.test(ssh)) {
    throw new Error(`ssh destination ${JSON.stringify(ssh)} is not a host name`);
  }
  if (wsl) {
    return buildWslRootLines(wsl, cmds).map((line) => (ssh ? `ssh ${ssh} ${line}` : line));
  }
  const prefix = ssh ? `ssh -t ${ssh} ` : "";
  return mergeRootCommands(cmds).map((line) => `${prefix}sudo ${line}`);
}

export function rootCommandOf(tool: ToolRootSpec | undefined, osName: string): string | null {
  const cmd = tool?.root?.[osName];
  return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
}

/** Plans how each lacking tool can be provided on a host of `osName`. */
export function planToolProvides(
  tools: Readonly<Record<string, ToolRootSpec>>,
  osName: string,
  lacks: ReadonlyArray<string>,
): ReadonlyArray<ProvidePlanItem> {
  const out: ProvidePlanItem[] = [];
  for (const line of lacks) {
    const atIdx = line.indexOf("@");
    const name = (atIdx >= 0 ? line.slice(0, atIdx) : line).trim();
    const spec = tools[name];
    if (!spec) {
      out.push({ kind: "none", tool: name, reason: "it is not a tool of the manifest" });
      continue;
    }
    if (/\(not on [a-z]+\)$/.test(line)) {
      out.push({
        kind: "none",
        tool: name,
        reason: `it is not for ${osName || "this system"}`,
      });
      continue;
    }
    const hasUser = Boolean(spec.install);
    const hasRoot = Boolean(rootCommandOf(spec, osName));
    if (hasUser && hasRoot) out.push({ kind: "both", tool: name });
    else if (hasUser) out.push({ kind: "user", tool: name });
    else if (hasRoot) out.push({ kind: "root", tool: name });
    else {
      out.push({
        kind: "none",
        tool: name,
        reason: `no user-level install and no root command for ${osName || "this system"}`,
      });
    }
  }
  return out;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Builds a deterministic needs-root grant request across one or more hosts. */
export function buildRootGrantRequest(
  tools: Readonly<Record<string, ToolRootSpec>>,
  rows: ReadonlyArray<RootGrantHostRow>,
): RootGrantRequest {
  const hosts: RootGrantHostEntry[] = [];
  for (const row of rows) {
    const cmds: string[] = [];
    for (const toolName of row.tools) {
      const rootCmd = rootCommandOf(tools[toolName], row.os);
      if (!rootCmd) {
        throw new Error(`${toolName} declares no root command for ${row.os || "this system"}`);
      }
      cmds.push(expandRootCommand(rootCmd, row.home));
    }
    hosts.push({
      host: row.host,
      ssh: row.ssh,
      tools: [...row.tools],
      ...(row.wsl ? { wsl: row.wsl } : {}),
      grant: buildGrantLines(row.ssh || row.host, cmds, row.wsl ?? ""),
      local: buildGrantLines("", cmds, row.wsl ?? ""),
    });
  }
  const request = NodeCrypto.createHash("sha256")
    .update(stableJson(hosts))
    .digest("hex")
    .slice(0, 12);
  return { request, hosts };
}

export function formatNeedsRootMarks(jobId: string, req: RootGrantRequest): ReadonlyArray<string> {
  const out: string[] = [];
  for (const h of req.hosts) {
    const lines = h.ssh ? h.grant : h.local;
    for (const line of lines) {
      out.push(
        `NEEDS_ROOT job=${jobId} host=${h.host} tools=${h.tools.join(",")} request=${req.request}: ${line}`,
      );
    }
  }
  return out;
}
