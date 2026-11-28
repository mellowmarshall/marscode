// @effect-diagnostics nodeBuiltinImport:off - Standalone post-merge installer runs from extracted base tree without Effect/node_modules.
// Runs one flag-parity probe in a process group of its own and ends that whole group when it is
// done or out of time, so nothing the probe started outlives it.
import * as NodeChildProcess from "node:child_process";

/**
 * The probe runner node executes: it starts the CLI detached (a new process
 * group), kills the group with SIGKILL on the deadline and once the CLI has
 * exited, and prints one JSON line: {status, stdout, timedOut} or {error}.
 */
const RUNNER = `
const { spawn } = require("node:child_process");
const [nodeBin, timeoutMs, ...argv] = process.argv.slice(1);
const report = (result) => process.stdout.write(JSON.stringify(result) + "\\n");
let stdout = "";
let timedOut = false;
const child = spawn(nodeBin, argv, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
const killGroup = () => {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
};
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.on("error", (error) => report({ error: error.message }));
const timer = setTimeout(() => { timedOut = true; killGroup(); }, Number(timeoutMs));
child.on("close", (status) => {
  clearTimeout(timer);
  killGroup();
  report({ status, stdout, timedOut });
});
`;

/** What one probe run gave: the CLI's exit status and stdout, or why it gave nothing. */
export type ProbeResult =
  | { readonly ran: true; readonly status: number | null; readonly stdout: string }
  | { readonly ran: false; readonly problem: string };

/** Runs `nodeBin bundle ...args` as a flag-parity probe, for at most `timeoutMs`. */
export function runProbe(input: {
  readonly nodeBin: string;
  readonly bundle: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
}): ProbeResult {
  const res = NodeChildProcess.spawnSync(
    input.nodeBin,
    ["-e", RUNNER, input.nodeBin, String(input.timeoutMs), input.bundle, ...input.args],
    // The runner ends the probe's group itself; this only bounds the runner.
    { cwd: input.cwd, encoding: "utf8", timeout: input.timeoutMs + 30_000 },
  );
  if (res.error) return { ran: false, problem: res.error.message };
  let result: { status?: number | null; stdout?: string; timedOut?: boolean; error?: string };
  try {
    result = JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return { ran: false, problem: `the probe runner exited ${res.status} with no result` };
  }
  if (result.error !== undefined) return { ran: false, problem: result.error };
  if (result.timedOut) return { ran: false, problem: `it timed out after ${input.timeoutMs} ms` };
  return { ran: true, status: result.status ?? null, stdout: result.stdout ?? "" };
}
