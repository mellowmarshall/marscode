// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off - Standalone post-merge installer runs from extracted base tree without Effect/node_modules.
// Ownership and flag-parity guard for marscode-sync: a CLI this installer did not write (another
// install's link or file) is replaced only by a MarsCode CLI that passes its flag-parity probe.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The line every MarsCode wrapper carries (infra/ci-host/ci-marscode-cli.sh writes the same one). */
export const WRAPPER_MARKER = "# Installed by MarsCode; reinstalls replace this file.";

export class CliParityRefusal extends Error {
  readonly binName: string;
  /** The probe did not run (spawn error or timeout): the next sync tries again. */
  readonly retry: boolean;
  constructor(binName: string, message: string, retry: boolean) {
    super(message);
    this.name = "CliParityRefusal";
    this.binName = binName;
    this.retry = retry;
  }
}

/** CLIs MarsCode owns outright: the sync always installs them, whatever sits at their bin path. */
const MARSCODE_OWNED = new Set(["ship-queue"]);

interface ProbeRun {
  readonly status: number | null;
  readonly stdout: string;
}

interface ParityProbe {
  /** What the probe proves, for the refusal message. */
  readonly what: string;
  readonly args: ReadonlyArray<string>;
  /** Why the run fails the probe, or null when it passes. */
  readonly judge: (run: ProbeRun) => string | null;
}

function helpNames(words: ReadonlyArray<string>) {
  return (run: ProbeRun): string | null => {
    if (run.status !== 0) return `--help exited ${run.status}`;
    const missing = words.filter((w) => !run.stdout.includes(w));
    return missing.length === 0 ? null : `--help does not name ${missing.join(", ")}`;
  };
}

const CI_SUITE_BEGIN = /^ci-suite: begin x pid=(\d+) by=runlog$/;
// cpu= is optional, as the queue reads it: runlog leaves it out where it cannot measure it.
const CI_SUITE_END = /^ci-suite: end x pass pid=(\d+)(?: cpu=\d+\.\d\d)? by=runlog$/;

/**
 * The flag-parity probe of each CLI ported from an original that other installs provide.
 * playbook has none: the port lacks subcommands the original's callers use (map,
 * review-model, doctor, up, snapshot, actions, storage), so it never replaces one.
 */
export const PARITY_PROBES: Readonly<Record<string, ParityProbe>> = {
  runlog: {
    what: "`runlog --ci-suite x -- true` prints its begin and end lines and exits 0",
    args: ["--ci-suite", "x", "--", "true"],
    judge: (run) => {
      const lines = run.stdout.split("\n").filter((s) => s !== "");
      const begin = CI_SUITE_BEGIN.exec(lines[0] ?? "");
      const end = CI_SUITE_END.exec(lines[1] ?? "");
      if (run.status !== 0) return `it exited ${run.status}`;
      if (lines.length !== 2 || !begin || !end) {
        return `it printed ${JSON.stringify(run.stdout.slice(0, 200))}`;
      }
      return begin[1] === end[1] ? null : "its begin and end lines name different pids";
    },
  },
  fleet: {
    what: "`fleet --help` names --kind, --json, check and init",
    args: ["--help"],
    judge: helpNames(["--kind", "--json", "fleet check", "fleet init"]),
  },
  surface: {
    what: "`surface --help` names api, client, --list, diff, check, verify-intent and init",
    args: ["--help"],
    judge: helpNames([
      "surface api",
      "surface client",
      "--list",
      "surface diff",
      "surface check",
      "surface verify-intent",
      "surface init",
    ]),
  },
};

/** What a CLI's parity probe is, as a fingerprint: a recorded skip with another one is retried. */
export function parityFingerprint(binName: string): string {
  const probe = PARITY_PROBES[binName];
  const text = probe
    ? JSON.stringify([probe.what, probe.args, probe.judge.toString()])
    : "no flag-parity probe";
  return NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** What sits at the bin path, when it is not a wrapper this installer wrote; null when it is ours or absent. */
export function foreignCli(binPath: string, bundlePath: string): string | null {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(binPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) {
    let target = "";
    try {
      target = NodeFS.readlinkSync(binPath);
    } catch {
      target = "an unreadable target";
    }
    return `a link to ${target}`;
  }
  if (!stat.isFile()) return "not a regular file";
  let text: string;
  try {
    text = NodeFS.readFileSync(binPath, "utf8");
  } catch {
    return "an unreadable file";
  }
  // Wrappers written before the marker name the release link's bundle.
  if (text.split("\n").includes(WRAPPER_MARKER) || text.includes(bundlePath)) return null;
  return "a file another install wrote";
}

/**
 * Throws a CliParityRefusal (its message is the one warning line the sync prints) when the bin path holds a CLI this installer did
 * not write and the staged CLI does not pass its flag-parity probe (a CLI with
 * no probe never replaces one it did not write).
 */
export function assertMayReplace(input: {
  readonly binName: string;
  readonly binPath: string;
  readonly bundlePath: string;
  readonly stagedBundle: string;
  readonly nodeBin: string;
  readonly cwd: string;
  readonly probeTimeoutMs?: number | undefined;
}): void {
  if (MARSCODE_OWNED.has(input.binName)) return;
  const foreign = foreignCli(input.binPath, input.bundlePath);
  if (foreign === null) return;
  const refuse = (why: string, retry = false) =>
    new CliParityRefusal(
      input.binName,
      `marscode-sync: warning: skipped ${input.binName}: kept ${input.binPath} (${foreign}, not installed by marscode-sync) ` +
        `because ${why}; ` +
        (retry
          ? "the next sync tries again."
          : `remove it to let marscode-sync install its ${input.binName}.`),
      retry,
    );
  const probe = PARITY_PROBES[input.binName];
  if (!probe) {
    throw refuse(`the MarsCode ${input.binName} has no flag-parity check`);
  }
  const res = NodeChildProcess.spawnSync(input.nodeBin, [input.stagedBundle, ...probe.args], {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: input.probeTimeoutMs ?? 60_000,
  });
  if (res.error) {
    throw refuse(`its flag-parity check did not run (${res.error.message})`, true);
  }
  const why = probe.judge({ status: res.status, stdout: res.stdout ?? "" });
  if (why !== null) {
    throw refuse(
      `the MarsCode ${input.binName} fails its flag-parity check (${probe.what}: ${why})`,
    );
  }
}

/** The release link's bundle a wrapper runs. */
export function wrapperBundlePath(libDir: string, binName: string): string {
  return NodePath.join(libDir, binName, "dist", "bin.mjs");
}
