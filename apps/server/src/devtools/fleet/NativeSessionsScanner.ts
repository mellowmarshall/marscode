// @effect-diagnostics nodeBuiltinImport:off - Native local hot/runaway process scanner with strict self-protection and PID-reuse guards.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { FleetSessionItem } from "./FleetTypes.ts";
import { collectProtectedSelfPids, readLinuxProcStartTicks } from "./NativeServersScanner.ts";

const PS_TIMEOUT_MS = 2_000;
const HIGH_CPU_PCT = 15;
const RUNAWAY_CPU_PCT = 80;
const HIGH_MEM_BYTES = 256 * 1024 * 1024;
const MAX_RETURNED_SESSIONS = 40;

const PROTECTED_COMM_RE =
  /^(?:systemd|init|sshd|tailscaled|dbus-daemon|pipewire|wireplumber|pulseaudio|gnome-shell|kwin|mutter|xwayland|sway|hyprland|t3code|t3-resource-monitor|electron|antigravity|dockerd|containerd|fusermount3?)$/i;

const PROTECTED_CMD_RE =
  /(?:T3-Code\.AppImage|T3 Code\.app|T3 Code Helper|apps\/server\/dist\/bin\.mjs|t3-resource-monitor|antigravity\s+acp|acp-mcp-bridge)/i;

export interface ParsedPsProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly cpuPct: number;
  readonly memBytes: number;
  readonly ageSeconds: number;
  readonly state: string;
  readonly comm: string;
  readonly args: string;
}

export function parseEtimeSeconds(etime: string): number {
  const trimmed = etime.trim();
  const daySplit = trimmed.split("-");
  let days = 0;
  let timePart = trimmed;
  if (daySplit.length === 2) {
    days = Number(daySplit[0]) || 0;
    timePart = daySplit[1] ?? "";
  }
  const parts = timePart.split(":").map((p) => Number(p) || 0);
  if (parts.length === 3) {
    return days * 86_400 + parts[0]! * 3_600 + parts[1]! * 60 + parts[2]!;
  }
  if (parts.length === 2) {
    return days * 86_400 + parts[0]! * 60 + parts[1]!;
  }
  return days * 86_400 + (parts[0] ?? 0);
}

function extractBasenameFromArgs(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "";
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  return NodePath.basename(firstToken);
}

/**
 * Parses `ps -o pid=,ppid=,pcpu=,rss=,etime=,stat=,args=`.
 * Avoids `comm=` before `args=` so macOS app paths containing spaces
 * (e.g. `/Applications/T3 Code.app/...`) never corrupt field boundaries.
 */
export function parsePsOutput(output: string): ReadonlyArray<ParsedPsProcess> {
  const out: ParsedPsProcess[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+([0-9:-]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cpuPct = Number(m[3]);
    const rssKb = Number(m[4]);
    const args = (m[7] ?? "").slice(0, 300);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    out.push({
      pid,
      ppid: Number.isInteger(ppid) ? ppid : 0,
      cpuPct: Number.isFinite(cpuPct) ? Math.round(cpuPct * 10) / 10 : 0,
      memBytes: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      ageSeconds: parseEtimeSeconds(m[5] ?? ""),
      state: m[6] ?? "",
      comm: extractBasenameFromArgs(args),
      args,
    });
  }
  return out;
}

function runUserPs(): Promise<string> {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const args = uid
    ? ["-u", uid, "-o", "pid=,ppid=,pcpu=,rss=,etime=,stat=,args=", "-ww"]
    : ["-eo", "pid=,ppid=,pcpu=,rss=,etime=,stat=,args=", "-ww"];
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "ps",
      args,
      {
        timeout: PS_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      (err, stdout) => {
        resolve(err ? "" : stdout);
      },
    );
  });
}

export class NativeSessionsScanner {
  private readonly platform: NodeJS.Platform;
  private latestById = new Map<
    string,
    { readonly pid: number; readonly startTicks: string | null; readonly item: FleetSessionItem }
  >();
  private latestList: ReadonlyArray<FleetSessionItem> = [];

  constructor(platform: NodeJS.Platform = "linux") {
    this.platform = platform;
  }

  getLatest(): ReadonlyArray<FleetSessionItem> {
    return this.latestList;
  }

  async scan(): Promise<ReadonlyArray<FleetSessionItem>> {
    const [psOut, ancestorProtected] = await Promise.all([
      runUserPs(),
      collectProtectedSelfPids(this.platform),
    ]);
    if (!psOut) return this.latestList;

    const procs = parsePsOutput(psOut);
    // Protect T3 ancestors and named runtime/ACP helpers, while still surfacing runaway
    // child build/test processes (e.g. vitest, tsc, cargo) so users can inspect or stop them.
    const protectedPids = new Set<number>(ancestorProtected);
    for (const p of procs) {
      if (PROTECTED_CMD_RE.test(p.args) || PROTECTED_COMM_RE.test(p.comm)) {
        protectedPids.add(p.pid);
      }
    }

    const candidates = procs
      .filter((p) => {
        if (protectedPids.has(p.pid)) return false;
        if (p.comm === "ps") return false;
        return p.cpuPct >= HIGH_CPU_PCT || p.memBytes >= HIGH_MEM_BYTES;
      })
      .toSorted((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes)
      .slice(0, MAX_RETURNED_SESSIONS);

    const nextMap = new Map<
      string,
      { readonly pid: number; readonly startTicks: string | null; readonly item: FleetSessionItem }
    >();
    const items: FleetSessionItem[] = [];
    const canCloseOnPlatform = this.platform === "linux";

    for (const p of candidates) {
      const [startTicks, linuxComm, cwd] = await Promise.all([
        readLinuxProcStartTicks(p.pid, this.platform),
        this.platform === "linux"
          ? NodeFSP.readFile(`/proc/${p.pid}/comm`, "utf8")
              .then((s) => s.trim())
              .catch(() => "")
          : Promise.resolve(""),
        this.platform === "linux"
          ? NodeFSP.readlink(`/proc/${p.pid}/cwd`).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      const displayName = linuxComm || p.comm || `pid-${p.pid}`;
      if (PROTECTED_COMM_RE.test(displayName)) continue;

      const id = startTicks ? `proc:${p.pid}:${startTicks}` : `proc:${p.pid}`;
      const project = cwd ? NodePath.basename(cwd) : undefined;
      const runaway = p.cpuPct >= RUNAWAY_CPU_PCT && p.ageSeconds >= 60;
      const orphaned = p.ppid === 1 && p.cpuPct >= HIGH_CPU_PCT;
      const closeAllowed = canCloseOnPlatform && startTicks !== null;
      const item: FleetSessionItem = {
        id,
        kind: "process",
        name: displayName,
        ...(project && project !== "/" ? { project } : {}),
        age_s: p.ageSeconds,
        mem_bytes: p.memBytes,
        cpu_pct: p.cpuPct,
        high: p.cpuPct >= HIGH_CPU_PCT || p.memBytes >= HIGH_MEM_BYTES,
        ...(runaway ? { runaway: true } : {}),
        ...(orphaned ? { orphaned: true } : {}),
        close_allowed: closeAllowed,
        ...(!closeAllowed
          ? { close_blocked_reason: "Closing processes is supported on Linux only" }
          : {}),
        command: p.args,
        pid: p.pid,
        ...(cwd ? { cwd } : {}),
      };
      nextMap.set(id, { pid: p.pid, startTicks, item });
      items.push(item);
    }

    this.latestById = nextMap;
    this.latestList = items;
    return items;
  }

  async closeSession(
    sessionId: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }> {
    if (this.platform !== "linux") {
      return { ok: false, message: "Closing processes is supported on Linux only" };
    }
    const entry = this.latestById.get(sessionId);
    if (!entry || entry.startTicks === null) {
      return { ok: false, message: `Session ${sessionId} not found in active scan` };
    }
    const protectedPids = await collectProtectedSelfPids(this.platform);
    if (protectedPids.has(entry.pid)) {
      return { ok: false, message: "Refusing to close protected T3 process" };
    }
    const currentTicks = await readLinuxProcStartTicks(entry.pid, this.platform);
    if (currentTicks !== entry.startTicks) {
      return {
        ok: false,
        message: `Process PID ${entry.pid} exited or was reused before close`,
      };
    }
    try {
      process.kill(entry.pid, "SIGTERM");
      this.latestById.delete(sessionId);
      this.latestList = this.latestList.filter((s) => s.id !== sessionId);
      return { ok: true, message: `Sent SIGTERM to ${entry.item.name} (PID ${entry.pid})` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : `Failed to stop PID ${entry.pid}`,
      };
    }
  }
}
