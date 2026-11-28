// @effect-diagnostics nodeBuiltinImport:off globalDate:off - `ship-queue hosts on|off`: an owner-only turn-on for a host turned off with a reason, and the CI toggle audit.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  appendCiToggleAudit,
  type CiToggleOffRecord,
  type CiToggleOutcome,
} from "./ciToggleAudit.ts";
import { readHostOffState, setCiHostAvailability } from "./hostProbe.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";

/** Runs the host guard's `ci-host-on-check` rule; exit 0 means the turn-on may go ahead. */
export type CiHostGuardRunner = (input: {
  readonly queueRoot: string;
  readonly host: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => Promise<{ readonly exitCode: number; readonly stderr: string }>;

const GUARD_WAIT_MS = 30 * 60_000;

/**
 * The installed `marscode-host-guard`, found from the passwd home directory (not `$HOME` or
 * `$PATH`, which the caller controls), owned by this user and not writable by others.
 */
function trustedGuardBinary(): string | null {
  let home = "";
  try {
    home = NodeOS.userInfo().homedir;
  } catch {
    // no passwd entry: only the system path is a candidate
  }
  const candidates = [
    ...(home ? [NodePath.join(home, ".local", "bin", "marscode-host-guard")] : []),
    "/usr/local/bin/marscode-host-guard",
  ];
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  for (const candidate of candidates) {
    try {
      const real = NodeFS.realpathSync(candidate);
      const st = NodeFS.statSync(real);
      if (!st.isFile() || (st.mode & 0o022) !== 0) continue;
      if (st.uid !== uid && st.uid !== 0) continue;
      return real;
    } catch {
      // not installed here
    }
  }
  return null;
}

export const installedCiHostGuard: CiHostGuardRunner = async (input) => {
  const bin = trustedGuardBinary();
  if (!bin) {
    return {
      exitCode: 1,
      stderr:
        "host guard: marscode-host-guard is not installed, so the owner cannot approve this here. " +
        "The owner can remove the .off marker by hand.",
    };
  }
  const res = await nodeProcessRunner({
    command: bin,
    args: [
      "ci-host-on-check",
      "--queue-root",
      input.queueRoot,
      "--cwd",
      input.cwd,
      "--",
      input.host,
    ],
    cwd: input.cwd,
    // The guard reads HOST_GUARD_OVERRIDE and the thread id from this environment.
    env: Object.fromEntries(
      Object.entries(input.env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
    timeoutMs: GUARD_WAIT_MS,
  });
  return { exitCode: res.exitCode, stderr: res.stderr };
};

function osUser(): string {
  try {
    return NodeOS.userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

function liveOff(queueRoot: string, host: string): CiToggleOffRecord | null {
  try {
    return readHostOffState(queueRoot, host);
  } catch {
    return { at: "", by: "", reason: "unreadable .off marker" };
  }
}

/**
 * `ship-queue hosts on|off NAME`. Turning on a host whose `.off` marker has a reason first passes
 * the host guard's owner-only rule (the `HOST_GUARD_OVERRIDE` approval flow), then removes only
 * that same marker. Every request is appended to the CI toggle audit.
 */
export async function runHostsToggle(input: {
  readonly queueRoot: string;
  readonly host: string;
  readonly enabled: boolean;
  readonly reason: string;
  readonly manifestPath: string | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly guard?: CiHostGuardRunner | undefined;
}): Promise<number> {
  const { queueRoot, host, enabled } = input;
  const prior = enabled ? liveOff(queueRoot, host) : null;
  const priorReason = prior?.reason.trim() ?? "";
  let confirmed = false;
  const audit = (outcome: CiToggleOutcome, message: string) =>
    appendCiToggleAudit(queueRoot, {
      at: new Date().toISOString(),
      host: host.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 128),
      on: enabled,
      outcome,
      actor: osUser(),
      client: "ship-queue-cli",
      confirmed,
      reason: enabled ? priorReason : input.reason,
      prior,
      message,
    }).ok;

  if (prior && priorReason) {
    const verdict = await (input.guard ?? installedCiHostGuard)({
      queueRoot,
      host,
      cwd: input.cwd,
      env: input.env,
    });
    if (verdict.stderr.trim()) input.stderr(`${verdict.stderr.trimEnd()}\n`);
    if (verdict.exitCode !== 0) {
      const message = `CI stays off on ${host}: turned off by ${prior.by || "unknown"} at ${prior.at || "an unknown time"} (${priorReason}); only the owner can turn it back on`;
      audit("refused", message);
      input.stderr(`${message}\n`);
      return verdict.exitCode;
    }
    confirmed = true;
    if (!audit("requested", `turning CI on for ${host} with owner approval`)) {
      input.stderr(`CI stays off on ${host}: the CI toggle audit cannot be written\n`);
      return 1;
    }
  }

  let res: { readonly ok: boolean; readonly message: string; readonly changed: boolean };
  try {
    res = setCiHostAvailability({
      queueRoot,
      hostName: host,
      enabled,
      reason: input.reason,
      manifestPath: input.manifestPath,
      expectOffAt: prior ? prior.at : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res = { ok: false, message, changed: false };
  }
  const audited = audit(!res.ok ? "failed" : res.changed ? "applied" : "unchanged", res.message);
  (res.ok ? input.stdout : input.stderr)(`${res.message}\n`);
  if (!audited)
    input.stderr("ship-queue hosts: warning: the CI toggle audit could not be written\n");
  return res.ok ? 0 : 1;
}
