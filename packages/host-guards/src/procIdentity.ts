// @effect-diagnostics nodeBuiltinImport:off - Caller identity classification, agent detection, controlling TTY, and terminal ancestry.
import * as NodePath from "node:path";
import { AGENT_THREAD_ENV } from "@t3tools/shared/procIdentity";

import {
  defaultProcFs,
  listAncestorsWithComm,
  readProcArgv,
  readProcCgroup,
  readProcStat,
  type ProcFsReader,
} from "./procFs.ts";

const T3_TERM_PROGRAM = "t3code";

const SESSION_KEY_RE =
  /^(?!XDG_|GNOME_|DBUS_|KDE_|SYSTEMD_|DESKTOP_|TERM_|ITERM_|WT_|MATE_|VTE_)(?:.*_(?:SESSION|CONVERSATION|THREAD)(?:_ID)?|AGENT_HEADLESS_UNIT)$/i;

const AI_PROC_NAMES = new Set([
  "claude",
  "codex",
  "agy",
  "antigravity",
  "grok",
  "cursor",
  "cursor-server",
  "aider",
  "goose",
  "kitty-agent-launch",
  "claudex",
  "dscode",
  "muse",
  "windsurf",
  "open-interpreter",
  "copilot",
  "devin",
  "agy_acp_server.",
  "agy_acp_server.par",
  "localharness_external",
  "agy_acp_shim.py",
]);

const AI_PROC_PREFIXES = ["claude", "codex", "antigravity", "cursor", "agy_acp"];
const AGENT_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "ANTIGRAVITY_AGENT",
  "CODEX_SANDBOX",
  "CURSOR_TRACE_ID",
];

const T3_AGENT_SLICE_RE = /app-t3code-agents-[0-9a-f]+\.slice/;
const T3_AGENT_SCOPE_RE = /t3code-(?!terminal-)[a-z0-9._-]+-[0-9a-f]+\.scope/;
const T3_TERMINAL_SCOPE_RE = /\/t3code-terminal-[0-9a-f]+\.scope(?:\s|$)/;
const SYSTEMD_TRANSIENT_SCOPE_RE = /\/run-(?:r[0-9a-f]+|p\d+-i\d+|u\d+)\.scope\b/;
const SYSTEMD_TRANSIENT_SERVICE_RE = /\/run-(?:r[0-9a-f]+|p\d+-i\d+|u\d+)\.service\b/;
const SYSTEMD_USER_SERVICE_RE = /\/user@\d+\.service\/(?:[^/\n]+\/)*[^/\n]+\.service(?:\/|\s|$)/;
const TRUSTED_BIN_PREFIXES = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/opt/",
  "/nix/store/",
  "/snap/",
  "/run/current-system/",
];
const ROOT_SESSION_COMMS = new Set(["login", "sshd", "sshd-session", "agetty"]);
const TERMINAL_ANCESTOR_EXES = new Set([
  "kitty",
  "sshd",
  "sshd-session",
  "login",
  "agetty",
  "mosh-server",
  "gnome-terminal-server",
  "kgx",
  "ptyxis",
  "ptyxis-agent",
  "konsole",
  "alacritty",
  "wezterm-gui",
  "wezterm-mux-server",
  "ghostty",
  "foot",
  "footclient",
  "xterm",
  "urxvt",
  "rxvt",
  "tilix",
  "terminator",
  "st",
  "xfce4-terminal",
  "mate-terminal",
  "lxterminal",
  "rio",
  "warp",
  "tabby",
  "hyper",
  "tmux",
  "screen",
  "zellij",
  "dtach",
  "code",
  "electron",
]);

export function isExplicitAgentCgroup(cg: string): boolean {
  if (!cg) return false;
  return cg.includes("agent-") || T3_AGENT_SLICE_RE.test(cg) || T3_AGENT_SCOPE_RE.test(cg);
}

export function isTransientServiceCgroup(cg: string): boolean {
  if (!cg) return false;
  return SYSTEMD_TRANSIENT_SERVICE_RE.test(cg);
}

export function isAgentCgroup(cg: string): boolean {
  if (!cg) return false;
  return (
    isExplicitAgentCgroup(cg) ||
    SYSTEMD_TRANSIENT_SCOPE_RE.test(cg) ||
    SYSTEMD_TRANSIENT_SERVICE_RE.test(cg)
  );
}

export function isSystemdUserService(
  pid: number | "self" = "self",
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  return SYSTEMD_USER_SERVICE_RE.test(readProcCgroup(pid, procFs));
}

export function hasControllingTty(procFs: ProcFsReader = defaultProcFs): boolean {
  if (procFs.hasProc()) {
    return readProcStat("self", procFs).ttyNr !== 0;
  }
  return Boolean(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
}

export function isAgentProcess(options?: {
  readonly startPid?: number | undefined;
  readonly testMode?: boolean | undefined;
  readonly allowTransientScope?: boolean | undefined;
  readonly procFs?: ProcFsReader | undefined;
}): boolean {
  if (options?.testMode === true) {
    return false;
  }
  const procFs = options?.procFs ?? defaultProcFs;
  const cg = readProcCgroup(options?.startPid ?? "self", procFs);
  if (
    options?.allowTransientScope
      ? isExplicitAgentCgroup(cg) || isTransientServiceCgroup(cg)
      : isAgentCgroup(cg)
  ) {
    return true;
  }
  for (const { pid, comm } of listAncestorsWithComm(options?.startPid, procFs)) {
    const rawExe = procFs.readLink(`/proc/${pid}/exe`) ?? "";
    let exe = NodePath.basename(rawExe.replace(/ \(deleted\)$/, ""));
    const args = !exe && !comm ? readProcArgv(pid, procFs) : [];
    if (!exe && args.length > 0) {
      exe = NodePath.basename(args[0] ?? "");
    }
    const names = [exe.toLowerCase(), comm.toLowerCase()].filter(Boolean);
    if (
      names.some(
        (n) => AI_PROC_NAMES.has(n) || AI_PROC_PREFIXES.some((prefix) => n.startsWith(prefix)),
      )
    ) {
      return true;
    }
    if (names.some((n) => n === "node" || n === "bun" || n.startsWith("python"))) {
      const scanArgs = args.length > 0 ? args : readProcArgv(pid, procFs);
      for (const arg of scanArgs) {
        const base = NodePath.basename(arg).toLowerCase();
        if (AI_PROC_NAMES.has(base) || AI_PROC_PREFIXES.some((prefix) => base.startsWith(prefix))) {
          return true;
        }
      }
    }
  }
  return false;
}

function isTrustedTerminalBinary(exePath: string, procFs: ProcFsReader): boolean {
  if (!exePath || exePath.endsWith(" (deleted)")) return false;
  const base = NodePath.basename(exePath).toLowerCase();
  if (!TERMINAL_ANCESTOR_EXES.has(base)) return false;
  const st = procFs.stat(exePath);
  if (!st) return false;
  return (
    st.uid === 0 &&
    (st.mode & 0o002) === 0 &&
    TRUSTED_BIN_PREFIXES.some((prefix) => exePath.startsWith(prefix))
  );
}

export function hasTerminalAncestor(options?: {
  readonly startPid?: number | undefined;
  readonly t3ServerPid?: number | null | undefined;
  readonly procFs?: ProcFsReader | undefined;
}): boolean {
  const procFs = options?.procFs ?? defaultProcFs;
  if (!procFs.hasProc()) return true;
  const selfCg = readProcCgroup(options?.startPid ?? "self", procFs);
  const inT3TermScope = T3_TERMINAL_SCOPE_RE.test(selfCg) && !isAgentCgroup(selfCg);
  const t3Pid = inT3TermScope ? (options?.t3ServerPid ?? null) : null;

  for (const { pid, comm } of listAncestorsWithComm(options?.startPid, procFs)) {
    if (inT3TermScope && t3Pid !== null && pid === t3Pid) return true;
    if (ROOT_SESSION_COMMS.has(comm.toLowerCase())) {
      const st = procFs.stat(`/proc/${pid}`);
      if (st && st.uid === 0) return true;
    }
    const exePath = procFs.readLink(`/proc/${pid}/exe`) ?? "";
    if (isTrustedTerminalBinary(exePath, procFs)) return true;
  }
  return false;
}

export interface CallerIdentity {
  readonly sessionId: string;
  readonly isAgent: boolean;
  readonly isT3Terminal: boolean;
}

export function resolveCallerIdentity(options?: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly testMode?: boolean | undefined;
  readonly procFs?: ProcFsReader | undefined;
  readonly t3ServerPid?: number | null | undefined;
}): CallerIdentity {
  const env = options?.env ?? process.env;
  const procFs = options?.procFs ?? defaultProcFs;
  const inTest = options?.testMode === true;
  let t3Val = "";
  let nonT3 = "";
  for (const [key, val] of Object.entries(env)) {
    const trimmed = val?.trim() ?? "";
    if (!trimmed) continue;
    if (key === AGENT_THREAD_ENV) {
      t3Val = trimmed;
      continue;
    }
    if (!nonT3 && SESSION_KEY_RE.test(key)) {
      nonT3 = trimmed;
    }
  }
  if (nonT3) return { sessionId: nonT3, isAgent: true, isT3Terminal: false };
  const isT3TermEnv = env.TERM_PROGRAM === T3_TERM_PROGRAM;
  if (t3Val && !isT3TermEnv) return { sessionId: t3Val, isAgent: true, isT3Terminal: false };

  const hasAgentEnv = AGENT_ENV_KEYS.some((k) => Boolean(env[k]?.trim()));
  if (hasAgentEnv && (!inTest || options?.env !== undefined)) {
    return { sessionId: t3Val, isAgent: true, isT3Terminal: false };
  }
  if (isAgentProcess({ testMode: inTest, procFs })) {
    return { sessionId: t3Val, isAgent: true, isT3Terminal: false };
  }
  if (inTest) return { sessionId: "", isAgent: false, isT3Terminal: isT3TermEnv };

  if (
    isT3TermEnv &&
    (!hasControllingTty(procFs) ||
      isSystemdUserService("self", procFs) ||
      !hasTerminalAncestor({ procFs, t3ServerPid: options?.t3ServerPid }))
  ) {
    return { sessionId: t3Val, isAgent: Boolean(t3Val), isT3Terminal: false };
  }
  return { sessionId: "", isAgent: false, isT3Terminal: isT3TermEnv };
}
