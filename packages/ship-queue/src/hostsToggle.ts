// @effect-diagnostics nodeBuiltinImport:off globalDate:off - `ship-queue hosts on|off`: an owner-only turn-on for a host turned off with a reason, and the CI toggle audit.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { isSafeHostName } from "./ciHosts.ts";
import { appendCiToggleAudit, type CiToggleOutcome } from "./ciToggleAudit.ts";
import { readHostOffState, setCiHostAvailability, type HostOffState } from "./hostOffMarker.ts";
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
 * The first candidate that is a regular file (after following symlinks), owned by `uid` or root,
 * and not writable by group or others. This stops environment redirection and other-user or
 * group/world-writable files; it cannot stop a same-user process that rewrites the guard files.
 */
export function pickTrustedGuardBinary(
  candidates: ReadonlyArray<string>,
  uid: number,
): string | null {
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

/** The installed guard, found from the passwd home directory, never from `$HOME` or `$PATH`. */
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
  return pickTrustedGuardBinary(
    candidates,
    typeof process.getuid === "function" ? process.getuid() : -1,
  );
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

function liveOff(queueRoot: string, host: string): HostOffState | null {
  try {
    return readHostOffState(queueRoot, host);
  } catch {
    // Exists but unreadable: off, and no version can match it, so it is never removed from here.
    return { at: "", by: "", reason: "unreadable .off marker", version: "" };
  }
}

/**
 * `ship-queue hosts on|off NAME`. The name is normalized once and used for every step. A turn-on
 * of a marker with a reason needs the host guard's owner approval; any marker removal is audited
 * first (or nothing changes), and only the marker version read here is removed.
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
  const { queueRoot, enabled } = input;
  const host = input.host.trim();
  if (!isSafeHostName(host)) {
    input.stderr(`ship-queue hosts: invalid host name ${JSON.stringify(input.host)}\n`);
    return 64;
  }
  const prior = enabled ? liveOff(queueRoot, host) : null;
  const priorReason = prior?.reason.trim() ?? "";
  let confirmed = false;
  const audit = (outcome: CiToggleOutcome, message: string) =>
    appendCiToggleAudit(queueRoot, {
      at: new Date().toISOString(),
      host,
      on: enabled,
      outcome,
      actor: osUser(),
      client: "ship-queue-cli",
      confirmed,
      reason: enabled ? priorReason : input.reason,
      prior,
      message,
    }).ok;
  const refuse = (message: string, code: number): number => {
    audit("refused", message);
    input.stderr(`${message}\n`);
    return code;
  };

  if (enabled && !prior) {
    // Nothing was read, so nothing is removed, even a marker written after this read.
    const message = `ci host ${host} is already on for CI`;
    audit("unchanged", message);
    input.stdout(`${message}\n`);
    return 0;
  }
  if (prior && !prior.version) {
    return refuse(`CI stays off on ${host}: its .off marker cannot be read; fix it by hand`, 1);
  }
  if (prior && priorReason) {
    const verdict = await (input.guard ?? installedCiHostGuard)({
      queueRoot,
      host,
      cwd: input.cwd,
      env: input.env,
    });
    if (verdict.stderr.trim()) input.stderr(`${verdict.stderr.trimEnd()}\n`);
    if (verdict.exitCode !== 0) {
      const who = `${prior.by || "unknown"} at ${prior.at || "an unknown time"} (${priorReason})`;
      return refuse(
        `CI stays off on ${host}: turned off by ${who}; only the owner can turn it back on`,
        verdict.exitCode,
      );
    }
    confirmed = true;
  }
  if (prior && !audit("requested", `turning CI on for ${host}`)) {
    input.stderr(`CI stays off on ${host}: the CI toggle audit cannot be written\n`);
    return 1;
  }

  let res: { readonly ok: boolean; readonly message: string; readonly changed: boolean };
  try {
    res = setCiHostAvailability({
      queueRoot,
      hostName: host,
      enabled,
      reason: input.reason,
      manifestPath: input.manifestPath,
      expectVersion: prior?.version,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res = { ok: false, message, changed: false };
  }
  const audited = audit(!res.ok ? "failed" : res.changed ? "applied" : "unchanged", res.message);
  (res.ok ? input.stdout : input.stderr)(`${res.message}\n`);
  if (!audited) {
    input.stderr("ship-queue hosts: warning: the CI toggle audit could not be written\n");
  }
  return res.ok ? 0 : 1;
}
