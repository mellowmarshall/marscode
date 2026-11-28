// @effect-diagnostics nodeBuiltinImport:off - `.off` marker removal: the router keeps excluding the host through every refused or failed turn-on.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadCiHostsManifest } from "./ciHosts.ts";
import { qualifyCiHosts } from "./ciRouter.ts";
import { isHostOff, readHostOffState, setCiHostAvailability } from "./hostOffMarker.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-off-marker-"));
  tempDirs.push(dir);
  const queueRoot = NodePath.join(dir, "sq");
  const manifestPath = NodePath.join(dir, "ci-hosts.json");
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: 1,
      hosts: [
        { name: "host-a", ssh: null, role: "ci" },
        { name: "host-b", ssh: "host-b", role: "ci" },
      ],
    }),
  );
  const loaded = loadCiHostsManifest({ overridePath: manifestPath });
  expect(loaded.errors).toEqual([]);
  const turnOff = (reason: string) =>
    expect(
      setCiHostAvailability({
        queueRoot,
        hostName: "host-b",
        enabled: false,
        reason,
        actor: "owner",
        manifestPath,
      }).ok,
    ).toBe(true);
  // Whether the CI router considers host-b at all right now, rather than skipping it as off.
  // (Its probe lacks the catalog's tools, so a considered host shows up with what it lacks.)
  const routerTakesHost = () => {
    const res = qualifyCiHosts({
      queueRoot,
      manifest: loaded.manifest!,
      probesByHost: { "host-a": null, "host-b": { __arch: "x86_64" } },
      requiredTools: [],
    });
    return res.qualified.some((h) => h.name === "host-b") || "host-b" in res.lacksByHost;
  };
  return { queueRoot, manifestPath, turnOff, routerTakesHost };
}

describe("CI host .off marker removal", () => {
  it("keeps the host excluded when a turn-on fails between the check and the unlink", () => {
    const { queueRoot, manifestPath, turnOff, routerTakesHost } = setup();
    turnOff("long task");
    expect(routerTakesHost()).toBe(false);
    const version = readHostOffState(queueRoot, "host-b")!.version;

    let seenDuring: boolean | null = null;
    expect(() =>
      setCiHostAvailability({
        queueRoot,
        hostName: "host-b",
        enabled: true,
        manifestPath,
        expectVersion: version,
        beforeUnlink: () => {
          seenDuring = routerTakesHost();
          throw new Error("injected failure");
        },
      }),
    ).toThrow("injected failure");
    // Verified but not yet removed: the router never saw the host as eligible.
    expect(seenDuring).toBe(false);
    expect(routerTakesHost()).toBe(false);
    expect(isHostOff(queueRoot, "host-b")).toBe(true);

    // The lock was released, so the same turn-on works afterwards.
    expect(
      setCiHostAvailability({
        queueRoot,
        hostName: "host-b",
        enabled: true,
        manifestPath,
        expectVersion: version,
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(routerTakesHost()).toBe(true);
  });

  it("refuses a stale version without ever removing or moving the marker", () => {
    const { queueRoot, manifestPath, turnOff, routerTakesHost } = setup();
    turnOff("long task");
    const marker = NodePath.join(queueRoot, "hosts", "host-b.off");
    const before = NodeFS.statSync(marker);
    const res = setCiHostAvailability({
      queueRoot,
      hostName: "host-b",
      enabled: true,
      manifestPath,
      expectVersion: "0".repeat(32),
      beforeUnlink: () => {
        throw new Error("must not get past the version check");
      },
    });
    expect(res.ok).toBe(false);
    expect(NodeFS.statSync(marker).ino).toBe(before.ino);
    expect(routerTakesHost()).toBe(false);
    expect(NodeFS.readdirSync(NodePath.dirname(marker))).toEqual(["host-b.off"]);
  });

  it("refuses when the marker is replaced after it was verified", () => {
    const { queueRoot, manifestPath, turnOff, routerTakesHost } = setup();
    turnOff("short task");
    const version = readHostOffState(queueRoot, "host-b")!.version;
    const marker = NodePath.join(queueRoot, "hosts", "host-b.off");
    const res = setCiHostAvailability({
      queueRoot,
      hostName: "host-b",
      enabled: true,
      manifestPath,
      expectVersion: version,
      beforeUnlink: () => {
        // A writer that skips the lock swaps in a new marker by rename.
        NodeFS.writeFileSync(`${marker}.new`, "reason=newer owner reason\n");
        NodeFS.renameSync(`${marker}.new`, marker);
      },
    });
    expect(res.ok).toBe(false);
    expect(readHostOffState(queueRoot, "host-b")?.reason).toBe("newer owner reason");
    expect(routerTakesHost()).toBe(false);
  });

  it("rejects a host name that is not a valid host id, such as one with spaces", () => {
    const { queueRoot, manifestPath, turnOff } = setup();
    turnOff("long task");
    const res = setCiHostAvailability({
      queueRoot,
      hostName: " host-b ",
      enabled: true,
      manifestPath,
    });
    expect(res.ok).toBe(false);
    expect(isHostOff(queueRoot, "host-b")).toBe(true);
  });
});
