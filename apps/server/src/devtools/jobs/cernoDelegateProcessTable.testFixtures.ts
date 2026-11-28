/**
 * A live host's process table where `/bin/bash` is the cerno shim: agent shells run as
 * `cerno-bash-delegate` over `/usr/libexec/cerno-real/bash`, and a `cerno watch` runs inside.
 * Argv, parents, cgroup and start ticks follow `/proc`; PIDs, paths and ids are generic.
 */
import { parsePsOutput } from "../fleet/NativeSessionsScanner.ts";
import type { ProcessTableRow } from "./jobProcessLoad.ts";

export interface FixtureProcess {
  readonly pid: number;
  readonly ppid: number;
  /** NUL-split `/proc/<pid>/cmdline`. */
  readonly argv: ReadonlyArray<string>;
  /** `readlink /proc/<pid>/exe`. */
  readonly exe: string;
  /** `/proc/<pid>/cgroup` (cgroup v2, one line). */
  readonly cgroup: string;
  /** Field 22 of `/proc/<pid>/stat`. */
  readonly startTicks: number;
  readonly cpuPct: number;
  readonly rssKb: number;
  /** `T3CODE_THREAD_ID` in `/proc/<pid>/environ`, when set. */
  readonly threadId?: string;
}

const AGENT_SCOPE =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-0a1b2c3d.slice/t3code-acp-5e6f7a8b.scope";
const CERNO_EXE = "/opt/cerno/bin/cerno";
const REAL_BASH = "/usr/libexec/cerno-real/bash";

export const DELEGATE_FIXTURE = {
  agentPid: 610_000,
  delegatePid: 610_100,
  realBashPid: 610_101,
  delegateMonitorPid: 610_102,
  watchPid: 610_200,
  watchStartTicks: 28_810_375,
  childPid: 610_201,
  workerPid: 610_202,
  watchMonitorPid: 610_203,
  /** A second agent shell with no `cerno watch`, as plain agent commands run. */
  plainDelegatePid: 620_100,
  plainRealBashPid: 620_101,
  plainWorkerPid: 620_102,
} as const;

/** The agent's command line, as the provider reports it and as `bash -c` receives it. */
export function agentWatchCommand(logPath: string): string {
  return `cerno watch --log ${logPath} -- ./run-suite.sh`;
}

export function delegateProcessTable(input: {
  readonly threadId: string;
  readonly logPath: string;
}): ReadonlyArray<FixtureProcess> {
  const f = DELEGATE_FIXTURE;
  const command = agentWatchCommand(input.logPath);
  const watchArgv = ["cerno", "watch", "--log", input.logPath, "--", "./run-suite.sh"];
  const plain = "cd web && npx tsc --noEmit && node scripts/inspect.mjs sheet";
  const base = { cgroup: AGENT_SCOPE, threadId: input.threadId };
  return [
    {
      ...base,
      pid: f.agentPid,
      ppid: 4_000,
      argv: ["agent-acp", "acp"],
      exe: "/opt/agent/agent-acp",
      startTicks: 28_500_000,
      cpuPct: 1.2,
      rssKb: 300_000,
    },
    {
      ...base,
      pid: f.delegatePid,
      ppid: f.agentPid,
      argv: ["cerno-bash-delegate", "/bin/bash", "-c", command],
      exe: CERNO_EXE,
      startTicks: 28_810_370,
      cpuPct: 0.1,
      rssKb: 6_300,
    },
    {
      ...base,
      pid: f.realBashPid,
      ppid: f.delegatePid,
      argv: [REAL_BASH, "-c", command],
      exe: REAL_BASH,
      startTicks: 28_810_371,
      cpuPct: 0,
      rssKb: 3_900,
    },
    {
      ...base,
      pid: f.delegateMonitorPid,
      ppid: f.delegatePid,
      argv: ["cerno-bash-delegate", "/bin/bash", "-c", command],
      exe: CERNO_EXE,
      startTicks: 28_810_371,
      cpuPct: 0,
      rssKb: 1_800,
    },
    {
      ...base,
      pid: f.watchPid,
      ppid: f.realBashPid,
      argv: watchArgv,
      exe: CERNO_EXE,
      startTicks: f.watchStartTicks,
      cpuPct: 0.4,
      rssKb: 6_600,
    },
    {
      ...base,
      pid: f.childPid,
      ppid: f.watchPid,
      argv: ["/bin/bash", "./run-suite.sh"],
      exe: REAL_BASH,
      startTicks: f.watchStartTicks,
      cpuPct: 0.6,
      rssKb: 4_000,
    },
    {
      ...base,
      pid: f.workerPid,
      ppid: f.childPid,
      argv: ["node", "suite.mjs"],
      exe: "/usr/bin/node",
      startTicks: f.watchStartTicks + 40,
      cpuPct: 92.5,
      rssKb: 512_000,
    },
    {
      ...base,
      pid: f.watchMonitorPid,
      ppid: f.watchPid,
      argv: watchArgv,
      exe: CERNO_EXE,
      startTicks: f.watchStartTicks,
      cpuPct: 0.3,
      rssKb: 2_000,
    },
    {
      ...base,
      pid: f.plainDelegatePid,
      ppid: f.agentPid,
      argv: ["cerno-bash-delegate", "bash", "-c", plain],
      exe: CERNO_EXE,
      startTicks: 28_586_198,
      cpuPct: 0.1,
      rssKb: 6_300,
    },
    {
      ...base,
      pid: f.plainRealBashPid,
      ppid: f.plainDelegatePid,
      argv: [REAL_BASH, "-c", plain],
      exe: REAL_BASH,
      startTicks: 28_586_200,
      cpuPct: 0,
      rssKb: 3_800,
    },
    {
      ...base,
      pid: f.plainWorkerPid,
      ppid: f.plainRealBashPid,
      argv: ["node", "scripts/inspect.mjs", "sheet"],
      exe: "/usr/bin/node",
      startTicks: 28_586_590,
      cpuPct: 0,
      rssKb: 90_000,
    },
  ];
}

/** The table as `ps -o pid=,ppid=,pcpu=,rss=,etime=,stat=,args=` prints it, through the real parser. */
export function toPsRows(table: ReadonlyArray<FixtureProcess>): ReadonlyArray<ProcessTableRow> {
  const text = table
    .map((p) => `${p.pid} ${p.ppid} ${p.cpuPct.toFixed(1)} ${p.rssKb} 09:21 S ${p.argv.join(" ")}`)
    .join("\n");
  return parsePsOutput(text);
}

/** `/proc` readers over the table, with the same rules the live readers apply. */
export function procReaders(table: ReadonlyArray<FixtureProcess>) {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  return {
    isPidAlive: (pid: number) => byPid.has(pid),
    readProcStartTicks: async (pid: number) => byPid.get(pid)?.startTicks ?? null,
    readProcRssBytes: async (pid: number) => {
      const kb = byPid.get(pid)?.rssKb;
      return kb ? kb * 1024 : undefined;
    },
    // `isCernoProcessPid`: the basename of argv[0] is `cerno` or `cerno-exec`.
    isCernoProcess: async (pid: number) => {
      const argv0 = byPid.get(pid)?.argv[0] ?? "";
      return ["cerno", "cerno-exec"].includes(argv0.split("/").pop() ?? "");
    },
    // `resolveThreadIdForPid`: the nearest of the PID and its ancestors that has the variable.
    resolveThreadId: async (pid: number) => {
      for (let p = byPid.get(pid), depth = 0; p && depth <= 6; depth += 1) {
        if (p.threadId) return p.threadId;
        p = byPid.get(p.ppid);
      }
      return undefined;
    },
  };
}

/**
 * The same agent command started again in a second shell while the first run still runs: a new
 * delegate, real shell and `cerno watch` tree with later start ticks and the same log path.
 */
export function withSecondRun(
  table: ReadonlyArray<FixtureProcess>,
  pidOffset: number,
  tickOffset: number,
): ReadonlyArray<FixtureProcess> {
  const f = DELEGATE_FIXTURE;
  const runPids = new Set<number>([
    f.delegatePid,
    f.realBashPid,
    f.delegateMonitorPid,
    f.watchPid,
    f.childPid,
    f.workerPid,
    f.watchMonitorPid,
  ]);
  const second = table
    .filter((p) => runPids.has(p.pid))
    .map((p) => ({
      ...p,
      pid: p.pid + pidOffset,
      ppid: runPids.has(p.ppid) ? p.ppid + pidOffset : p.ppid,
      startTicks: p.startTicks + tickOffset,
    }));
  return [...table, ...second];
}
