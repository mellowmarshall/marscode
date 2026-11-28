// @effect-diagnostics nodeBuiltinImport:off - A Fleet CI turn-on that removes a reasoned `.off` marker needs confirm, and every toggle is audited.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isHostOff, setCiHostAvailability } from "@t3tools/ship-queue/hostProbe";

import { ciToggleAuditPath, readCiToggleAudit } from "./CiToggleAudit.ts";
import { handleNativeFleetRequest } from "./FleetRoutes.ts";
import { NativeCiHosts } from "./NativeCiHosts.ts";
import { NativeFleetService } from "./NativeFleetService.ts";

const tempDirs: string[] = [];
const OFF_AT = "2026-11-28T11:00:00.000Z";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ci-toggle-"));
  tempDirs.push(dir);
  const queueRoot = NodePath.join(dir, "sq");
  const manifestPath = NodePath.join(dir, "ci-hosts.json");
  NodeFS.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: 1,
      hosts: [
        { name: "host-a", ssh: null },
        { name: "host-b", ssh: "host-b" },
      ],
    }),
  );
  const ciHosts = new NativeCiHosts({
    stateFile: NodePath.join(dir, "hosts-check.json"),
    queueRoot,
    manifestPath,
  });
  return { dir, queueRoot, manifestPath, ciHosts };
}

function ownerTurnsOff(queueRoot: string, manifestPath: string, hostName = "host-b"): void {
  const res = setCiHostAvailability({
    queueRoot,
    hostName,
    enabled: false,
    reason: "runs a long simulation; keep CI off",
    actor: "owner",
    manifestPath,
    nowIso: () => OFF_AT,
  });
  expect(res.ok).toBe(true);
}

describe("Fleet CI toggle confirmation and audit", () => {
  it("refuses an unconfirmed turn-on of a host whose .off marker has a reason, and audits it", async () => {
    const { queueRoot, manifestPath, ciHosts } = setup();
    ownerTurnsOff(queueRoot, manifestPath);

    const refused = await ciHosts.setCi("host-b", true, undefined, {
      actor: "browser-session",
      client: "fleet-console",
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("runs a long simulation; keep CI off");
    expect(refused.message).toContain("owner");
    expect(isHostOff(queueRoot, "host-b")).toBe(true);
    expect(ciHosts.getPanel().report?.hosts.find((h) => h.name === "host-b")).toMatchObject({
      ci_off: true,
      ci_off_by: "owner",
      ci_off_at: "2026-11-28T11:00:00.000Z",
      ci_off_reason: "runs a long simulation; keep CI off",
    });

    // A confirmation without the shown marker's time, or with another time, is refused too.
    for (const confirmAt of [undefined, "2026-11-27T09:00:00.000Z"]) {
      const stale = await ciHosts.setCi("host-b", true, undefined, { confirm: true, confirmAt });
      expect(stale.ok).toBe(false);
      expect(isHostOff(queueRoot, "host-b")).toBe(true);
    }

    const confirmed = await ciHosts.setCi("host-b", true, undefined, {
      confirm: true,
      confirmAt: OFF_AT,
      actor: "browser-session",
      client: "fleet-console",
    });
    expect(confirmed.ok).toBe(true);
    expect(isHostOff(queueRoot, "host-b")).toBe(false);

    const audit = readCiToggleAudit(queueRoot).filter((e) => e.actor === "browser-session");
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({
      host: "host-b",
      on: true,
      outcome: "refused",
      actor: "browser-session",
      client: "fleet-console",
      confirmed: false,
      reason: "runs a long simulation; keep CI off",
      prior: { by: "owner", at: "2026-11-28T11:00:00.000Z" },
    });
    // The turn-on is recorded before the marker is removed, then its outcome.
    expect(audit[1]).toMatchObject({ host: "host-b", on: true, outcome: "requested" });
    expect(audit[2]).toMatchObject({
      host: "host-b",
      on: true,
      outcome: "applied",
      confirmed: true,
      prior: { by: "owner", reason: "runs a long simulation; keep CI off" },
    });
    expect(typeof audit[2]?.at).toBe("string");
    expect(
      readCiToggleAudit(queueRoot)
        .filter((e) => e.outcome === "refused")
        .map((e) => e.confirmed),
    ).toEqual([false, true, true]);
  });

  it("turns CI off in one request and records who turned it off", async () => {
    const { queueRoot, ciHosts } = setup();
    const res = await ciHosts.setCi("host-a", false, undefined, {
      actor: "browser-session",
      client: "fleet-console",
    });
    expect(res.ok).toBe(true);
    expect(isHostOff(queueRoot, "host-a")).toBe(true);
    const [entry] = readCiToggleAudit(queueRoot);
    expect(entry).toMatchObject({
      host: "host-a",
      on: false,
      outcome: "applied",
      actor: "browser-session",
      prior: null,
    });
    expect(ciHosts.getPanel().report?.hosts.find((h) => h.name === "host-a")).toMatchObject({
      ci_off: true,
      ci_off_by: "t3code (browser-session)",
      ci_off_reason: null,
    });
    // The console's own marker has no reason, so turning it back on needs no confirmation.
    expect((await ciHosts.setCi("host-a", true)).ok).toBe(true);
    expect(isHostOff(queueRoot, "host-a")).toBe(false);
  });

  it("shows a marker that ship-queue wrote after the last hosts check", async () => {
    const { dir, queueRoot, manifestPath } = setup();
    NodeFS.writeFileSync(
      NodePath.join(dir, "hosts-check.json"),
      JSON.stringify({
        schema: 1,
        at: "2026-11-28T10:00:00.000Z",
        hosts: [{ name: "host-b", ssh: "host-b", reached: true, ci_off: false }],
      }),
    );
    const ciHosts = new NativeCiHosts({
      stateFile: NodePath.join(dir, "hosts-check.json"),
      queueRoot,
      manifestPath,
    });
    expect(ciHosts.getPanel().report?.hosts.find((h) => h.name === "host-b")?.ci_off).toBe(false);
    ownerTurnsOff(queueRoot, manifestPath);
    expect(ciHosts.getPanel().report?.hosts.find((h) => h.name === "host-b")).toMatchObject({
      ci_off: true,
      reached: true,
      ci_off_reason: "runs a long simulation; keep CI off",
    });
  });

  it("the HTTP route returns 409 without confirm, records the session subject, and applies with confirm", async () => {
    const { dir, queueRoot, manifestPath } = setup();
    ownerTurnsOff(queueRoot, manifestPath);
    const fleet = new NativeFleetService({
      hostname: "host-a",
      stateDir: NodePath.join(dir, "state"),
      queueRoot,
      manifestPath,
      enableBackgroundPolling: false,
    });
    try {
      const refused = await handleNativeFleetRequest(
        fleet,
        "POST",
        "/api/hosts/host-b/ci",
        { on: true, client: "fleet-console" },
        "session-subject-1",
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ needs_confirm: true });
      expect(isHostOff(queueRoot, "host-b")).toBe(true);

      const bad = await handleNativeFleetRequest(fleet, "POST", "/api/hosts/host-b/ci", {
        on: true,
        confirm: "yes",
      });
      expect(bad.status).toBe(400);
      expect(isHostOff(queueRoot, "host-b")).toBe(true);

      const accepted = await handleNativeFleetRequest(
        fleet,
        "POST",
        "/api/hosts/host-b/ci",
        { on: true, confirm: true, confirm_at: OFF_AT, client: "fleet-console" },
        "session-subject-1",
      );
      expect(accepted.status).toBe(202);
      const actionId = (accepted.body as { action_id: string }).action_id;
      await expect.poll(() => fleet.getAction(actionId)?.state).toBe("ok");
      expect(isHostOff(queueRoot, "host-b")).toBe(false);

      const audit = readCiToggleAudit(queueRoot);
      expect(audit.map((e) => [e.outcome, e.actor, e.client, e.confirmed])).toEqual([
        ["refused", "session-subject-1", "fleet-console", false],
        ["requested", "session-subject-1", "fleet-console", true],
        ["applied", "session-subject-1", "fleet-console", true],
      ]);
      expect(NodeFS.statSync(ciToggleAuditPath(queueRoot)).mode & 0o777).toBe(0o600);
    } finally {
      fleet.close();
    }
  });

  it("turns a host on without confirm when its .off marker has no reason", async () => {
    const { queueRoot, manifestPath, ciHosts } = setup();
    expect(
      setCiHostAvailability({ queueRoot, hostName: "host-b", enabled: false, manifestPath }).ok,
    ).toBe(true);
    expect((await ciHosts.setCi("host-b", true)).ok).toBe(true);
    expect(isHostOff(queueRoot, "host-b")).toBe(false);
    expect(readCiToggleAudit(queueRoot).map((e) => [e.outcome, e.actor])).toEqual([
      ["requested", "unknown"],
      ["applied", "unknown"],
    ]);
  });

  it("refuses to turn on a host whose .off marker cannot be read, even with confirm", async () => {
    const { queueRoot, ciHosts } = setup();
    const marker = NodePath.join(queueRoot, "hosts", "host-b.off");
    NodeFS.mkdirSync(marker, { recursive: true });
    const res = await ciHosts.setCi("host-b", true, undefined, { confirm: true, confirmAt: "" });
    expect(res.ok).toBe(false);
    expect(NodeFS.existsSync(marker)).toBe(true);
    expect(ciHosts.getPanel().report?.hosts.find((h) => h.name === "host-b")).toMatchObject({
      ci_off: true,
      ci_off_reason: "unreadable .off marker",
    });
    expect(readCiToggleAudit(queueRoot)[0]).toMatchObject({ outcome: "refused", on: true });
  });

  it("treats the text of a hand-written .off marker as its reason", async () => {
    const { queueRoot, ciHosts } = setup();
    NodeFS.mkdirSync(NodePath.join(queueRoot, "hosts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(queueRoot, "hosts", "host-b.off"), "long render job\n");
    const res = await ciHosts.setCi("host-b", true);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("long render job");
    expect(isHostOff(queueRoot, "host-b")).toBe(true);
  });

  it("audits a request for an unknown host", async () => {
    const { queueRoot, ciHosts } = setup();
    expect((await ciHosts.setCi("host-z", true, undefined, { actor: "s1" })).ok).toBe(false);
    expect(readCiToggleAudit(queueRoot)[0]).toMatchObject({
      host: "host-z",
      outcome: "refused",
      actor: "s1",
    });
  });

  it("ship-queue removes a marker only when it is still the one that was checked", () => {
    const { queueRoot, manifestPath } = setup();
    ownerTurnsOff(queueRoot, manifestPath);
    const on = (expectOffAt: string) =>
      setCiHostAvailability({
        queueRoot,
        hostName: "host-b",
        enabled: true,
        manifestPath,
        expectOffAt,
      });
    expect(on("2026-11-27T09:00:00.000Z").ok).toBe(false);
    expect(isHostOff(queueRoot, "host-b")).toBe(true);
    expect(NodeFS.readdirSync(NodePath.join(queueRoot, "hosts"))).toEqual(["host-b.off"]);
    expect(on(OFF_AT)).toMatchObject({ ok: true, changed: true });
    expect(isHostOff(queueRoot, "host-b")).toBe(false);
  });
});
