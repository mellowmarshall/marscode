// @effect-diagnostics nodeBuiltinImport:off - Unit tests for verified systemd user-service lookup used by fleet session close.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

import {
  parseSystemctlShow,
  defaultSystemdUserServiceDeps,
  parseUserServiceUnit,
  resolveVerifiedUserService,
  stopUserService,
  type SystemdUserServiceDeps,
} from "./FleetSystemdUnits.ts";

const SERVICE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/usage-collect.service\n";

function depsFor(cgroup: string, show: string, calls: string[][] = []): SystemdUserServiceDeps {
  return {
    readCgroup: async () => cgroup,
    systemctl: async (args) => {
      calls.push([...args]);
      if (args[0] === "show") return { ok: true, stdout: show, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
  };
}

describe("parseUserServiceUnit", () => {
  it("finds the user service that owns a process from its cgroup v2 path", () => {
    expect(parseUserServiceUnit(SERVICE_CGROUP)).toBe("usage-collect.service");
    expect(
      parseUserServiceUnit(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/worker@lan.service\n",
      ),
    ).toBe("worker@lan.service");
  });

  it("gives null for scopes, system services, the user manager, and protected units", () => {
    expect(
      parseUserServiceUnit(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-firefox-123.scope\n",
      ),
    ).toBeNull();
    expect(parseUserServiceUnit("0::/system.slice/docker.service\n")).toBeNull();
    expect(parseUserServiceUnit("0::/user.slice/user-1000.slice/user@1000.service\n")).toBeNull();
    expect(
      parseUserServiceUnit(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/t3code.service\n",
      ),
    ).toBeNull();
    expect(parseUserServiceUnit("")).toBeNull();
  });

  it("parses this test process's real cgroup file without throwing", () => {
    let text = "";
    try {
      text = NodeFS.readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return;
    }
    const unit = parseUserServiceUnit(text);
    expect(unit === null || unit.endsWith(".service")).toBe(true);
  });
});

describe("resolveVerifiedUserService + stopUserService", () => {
  it("stops a unit only when systemd confirms the PID is its active main process", async () => {
    const calls: string[][] = [];
    const deps = depsFor(
      SERVICE_CGROUP,
      "Id=usage-collect.service\nMainPID=4242\nActiveState=active\n",
      calls,
    );
    expect(await resolveVerifiedUserService(4242, deps)).toBe("usage-collect.service");
    expect(await stopUserService("usage-collect.service", deps)).toEqual({
      ok: true,
      message: "Stopped user service usage-collect.service",
    });
    expect(calls).toEqual([
      ["show", "--property=Id,MainPID,ActiveState", "--", "usage-collect.service"],
      ["stop", "--", "usage-collect.service"],
    ]);
  });

  it("falls back (null) for a child of the unit, an inactive unit, or a renamed unit", async () => {
    const child = depsFor(
      SERVICE_CGROUP,
      "Id=usage-collect.service\nMainPID=1\nActiveState=active",
    );
    expect(await resolveVerifiedUserService(4242, child)).toBeNull();
    const inactive = depsFor(
      SERVICE_CGROUP,
      "Id=usage-collect.service\nMainPID=4242\nActiveState=inactive",
    );
    expect(await resolveVerifiedUserService(4242, inactive)).toBeNull();
    const renamed = depsFor(SERVICE_CGROUP, "Id=other.service\nMainPID=4242\nActiveState=active");
    expect(await resolveVerifiedUserService(4242, renamed)).toBeNull();
  });

  it("refuses protected or malformed unit names", async () => {
    const deps = depsFor(SERVICE_CGROUP, "");
    expect((await stopUserService("t3code.service", deps)).ok).toBe(false);
    expect((await stopUserService("../evil.service", deps)).ok).toBe(false);
    expect((await stopUserService("--now.service x", deps)).ok).toBe(false);
  });

  it("parses systemctl show output", () => {
    expect(parseSystemctlShow("Id=a.service\nMainPID=0\nActiveState=failed\n")).toEqual({
      id: "a.service",
      mainPid: 0,
      activeState: "failed",
    });
  });
});

describe("real systemd user manager", () => {
  it("verifies and stops a transient user service by its main PID", async () => {
    const unit = `t3-fleet-close-test-${NodeCrypto.randomBytes(4).toString("hex")}.service`;
    try {
      NodeChildProcess.execFileSync(
        "systemd-run",
        ["--user", "--quiet", "--collect", `--unit=${unit}`, "sleep", "300"],
        { stdio: "ignore", timeout: 10_000 },
      );
    } catch {
      // No user systemd manager here (CI container, macOS): nothing to verify against.
      return;
    }
    try {
      const shown = await defaultSystemdUserServiceDeps.systemctl([
        "show",
        "--property=Id,MainPID,ActiveState",
        "--",
        unit,
      ]);
      const { mainPid } = parseSystemctlShow(shown.stdout);
      expect(mainPid).toBeGreaterThan(1);
      expect(await resolveVerifiedUserService(mainPid)).toBe(unit);
      expect(await resolveVerifiedUserService(process.pid)).not.toBe(unit);
      expect((await stopUserService(unit)).ok).toBe(true);
      const after = await defaultSystemdUserServiceDeps.systemctl([
        "show",
        "--property=ActiveState",
        "--",
        unit,
      ]);
      expect(after.stdout.trim()).not.toBe("ActiveState=active");
    } finally {
      await defaultSystemdUserServiceDeps.systemctl(["stop", "--", unit]);
    }
  });
});
