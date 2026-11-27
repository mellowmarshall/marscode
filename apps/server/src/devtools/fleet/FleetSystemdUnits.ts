// @effect-diagnostics nodeBuiltinImport:off - Verified systemd user-service lookup and stop for native fleet session close.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

const SYSTEMCTL_TIMEOUT_MS = 20_000;
const SAFE_UNIT_RE = /^[A-Za-z0-9:_.@\\-]{1,200}\.service$/;
const PROTECTED_UNIT_RE = /^(?:t3code|t3-resource-monitor|dbus|pipewire|wireplumber|pulseaudio)\b/i;

/**
 * The user service that owns a process, from its cgroup v2 path
 * (`0::/user.slice/user-1000.slice/user@1000.service/app.slice/foo.service`).
 * Scopes, system services, and the user manager itself give null.
 */
export function parseUserServiceUnit(cgroupText: string): string | null {
  for (const line of cgroupText.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const segments = line.slice(3).trim().split("/").filter(Boolean);
    const managerIdx = segments.findIndex((seg) => /^user@\d+\.service$/.test(seg));
    if (managerIdx === -1) return null;
    const leaf = segments.at(-1);
    if (segments.length <= managerIdx + 1 || leaf === undefined) return null;
    return SAFE_UNIT_RE.test(leaf) && !PROTECTED_UNIT_RE.test(leaf) ? leaf : null;
  }
  return null;
}

/** Parses `systemctl show --property=Id,MainPID,ActiveState` output. */
export function parseSystemctlShow(output: string): {
  readonly id: string;
  readonly mainPid: number;
  readonly activeState: string;
} {
  const props = new Map<string, string>();
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const mainPid = Number(props.get("MainPID") ?? "0");
  return {
    id: props.get("Id") ?? "",
    mainPid: Number.isInteger(mainPid) ? mainPid : 0,
    activeState: props.get("ActiveState") ?? "",
  };
}

export interface SystemdUserServiceDeps {
  readonly readCgroup: (pid: number) => Promise<string>;
  readonly systemctl: (
    args: ReadonlyArray<string>,
  ) => Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }>;
}

function runSystemctl(
  args: ReadonlyArray<string>,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "systemctl",
      ["--user", ...args],
      { timeout: SYSTEMCTL_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr || (err ? err.message : "") });
      },
    );
  });
}

export const defaultSystemdUserServiceDeps: SystemdUserServiceDeps = {
  readCgroup: (pid) => NodeFSP.readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => ""),
  systemctl: runSystemctl,
};

/**
 * The user service whose main process is `pid`, verified against systemd. A child of a
 * service, an inactive unit, or a unit systemd names differently gives null.
 */
export async function resolveVerifiedUserService(
  pid: number,
  deps: SystemdUserServiceDeps = defaultSystemdUserServiceDeps,
): Promise<string | null> {
  const unit = parseUserServiceUnit(await deps.readCgroup(pid));
  if (unit === null) return null;
  const shown = await deps.systemctl(["show", "--property=Id,MainPID,ActiveState", "--", unit]);
  if (!shown.ok) return null;
  const info = parseSystemctlShow(shown.stdout);
  if (info.id !== unit || info.mainPid !== pid) return null;
  return info.activeState === "active" || info.activeState === "reloading" ? unit : null;
}

/** Stops a user service so its restart policy does not bring the process back. */
export async function stopUserService(
  unit: string,
  deps: SystemdUserServiceDeps = defaultSystemdUserServiceDeps,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  if (!SAFE_UNIT_RE.test(unit) || PROTECTED_UNIT_RE.test(unit)) {
    return { ok: false, message: `Refusing to stop user service ${unit}` };
  }
  const res = await deps.systemctl(["stop", "--", unit]);
  return res.ok
    ? { ok: true, message: `Stopped user service ${unit}` }
    : { ok: false, message: res.stderr.trim() || `Failed to stop user service ${unit}` };
}
