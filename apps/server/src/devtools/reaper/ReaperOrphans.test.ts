// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { inAgentScope } from "../../process/agentScope.ts";
import { readLinuxProcStartTicks } from "../fleet/NativeServersScanner.ts";
import {
  findOrphans,
  isDarwinOrphanCommand,
  isLinuxOrphanCommand,
  signalVerified,
} from "./ReaperOrphans.ts";

const platform = HostProcess.Platform.defaultValue();
const spawned: NodeChildProcess.ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function spawnSleeper(argv: ReadonlyArray<string> = ["sleep", "7200"]) {
  const child = NodeChildProcess.spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
  spawned.push(child);
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("exit", (_code, signal) => resolve(signal)),
  );
  return { child, pid: child.pid!, exited };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("orphan helpers", () => {
  it("matches headless browsers and long test sleeps, not ordinary commands", () => {
    expect(
      isLinuxOrphanCommand("/opt/google/chrome/chrome --headless=new --remote-debugging-port=0"),
    ).toBe(true);
    expect(isLinuxOrphanCommand("node /home/u/.local/bin/agent-browser serve")).toBe(true);
    expect(isLinuxOrphanCommand("Xvfb :99 -screen 0 1280x720x24")).toBe(true);
    expect(isLinuxOrphanCommand("dbus-daemon --nofork --address=unix:path=/tmp/dbus-x")).toBe(true);
    expect(isLinuxOrphanCommand("sleep 7200")).toBe(true);
    expect(isLinuxOrphanCommand("sleep 60")).toBe(false);
    expect(isLinuxOrphanCommand("/usr/bin/chrome --profile-directory=Default")).toBe(false);
    expect(isLinuxOrphanCommand("vim notes-sleep 9999")).toBe(false);
    expect(
      isDarwinOrphanCommand(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless",
      ),
    ).toBe(true);
    expect(isDarwinOrphanCommand("/usr/bin/ssh-agent")).toBe(false);
  });

  it.skipIf(platform !== "linux")(
    "never signals a PID whose start time no longer matches",
    async () => {
      const { pid, exited } = spawnSleeper();
      const ticks = await readLinuxProcStartTicks(pid, platform);
      expect(ticks).not.toBeNull();

      const reused = await signalVerified(
        { pid, cmd: "sleep 7200", ageS: 4_000, identity: `${ticks}0` },
        "SIGTERM",
        platform,
      );
      expect(reused).toBe(false);
      expect(alive(pid)).toBe(true);

      const same = await signalVerified(
        { pid, cmd: "sleep 7200", ageS: 4_000, identity: ticks! },
        "SIGTERM",
        platform,
      );
      expect(same).toBe(true);
      expect(await exited).toBe("SIGTERM");

      const gone = await signalVerified(
        { pid, cmd: "sleep 7200", ageS: 4_000, identity: ticks! },
        "SIGKILL",
        platform,
      );
      expect(gone).toBe(false);
    },
  );

  const ownCgroup = platform === "linux" ? NodeFS.readFileSync("/proc/self/cgroup", "utf8") : "";
  const scopeArgs = ["--user", "--scope", "--quiet", "--collect", "--"];
  const systemdRun =
    platform === "linux" &&
    NodeChildProcess.spawnSync("systemd-run", [...scopeArgs, "true"]).status === 0;
  const adoptedPs = (pid: number) =>
    [
      `${pid} 1 0.0 1024 01:10:00 S sleep 7200`,
      `${process.pid} 1 0.0 1024 01:10:00 S sleep 7200`,
      `${pid + 100_000} 1 0.0 1024 00:05:00 S sleep 7200`,
    ].join("\n");

  it.skipIf(platform !== "linux" || inAgentScope(ownCgroup))(
    "finds an adopted helper with its start-time guard and skips this server",
    async () => {
      const { pid } = spawnSleeper();
      const found = await findOrphans(platform, { psOutput: adoptedPs(pid) });
      expect(found.map((o) => o.pid)).toEqual([pid]);
      expect(found[0]?.identity).toBe(await readLinuxProcStartTicks(pid, platform));
    },
  );

  it.skipIf(platform !== "linux" || !inAgentScope(ownCgroup))(
    "leaves a helper inside a T3 agent scope to the thread that owns it",
    async () => {
      const { pid } = spawnSleeper();
      expect(await findOrphans(platform, { psOutput: adoptedPs(pid) })).toEqual([]);
    },
  );

  it.skipIf(platform !== "linux" || !systemdRun)(
    "finds the same helper once it runs outside any agent scope",
    async () => {
      // The scope exists once the shell runs; it then execs sleep in the same PID.
      const child = NodeChildProcess.spawn(
        "systemd-run",
        [...scopeArgs, "sh", "-c", "echo ready; exec sleep 7200"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      spawned.push(child);
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      const pid = child.pid!;
      const found = await findOrphans(platform, { psOutput: adoptedPs(pid) });
      expect(found.map((o) => o.pid)).toEqual([pid]);
    },
  );
});
