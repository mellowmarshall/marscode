// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  classifyContainer,
  classifyNetwork,
  isCheckoutDeleted,
  reapDocker,
  type DockerRunner,
  type DockerScope,
} from "./ReaperDocker.ts";

const NOW_MS = Date.parse("2030-06-01T12:00:00.000Z");
const OLD = "2030-06-01T10:00:00.123456789Z";
const YOUNG = "2030-06-01T11:58:00.000000000Z";
const DEAD = new Set([4242, 5151]);
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const scope = (over: Partial<DockerScope> = {}): DockerScope => ({
  nowMs: NOW_MS,
  selfHost: "workstation",
  selfPidNs: "pid:[4026531836]",
  sharedDaemon: false,
  pidDead: (pid) => DEAD.has(pid),
  checkoutDeleted: isCheckoutDeleted,
  ...over,
});

const container = (
  name: string,
  labels: Record<string, string>,
  extra: Record<string, unknown> = {},
) => ({
  Id: `id-${name}`,
  Name: `/${name}`,
  Created: OLD,
  Config: { Labels: labels },
  HostConfig: { RestartPolicy: { Name: "no" } },
  ...extra,
});

describe("docker reap safety", () => {
  it("reaps a container only by a positive allowlist rule", async () => {
    const s = scope();
    expect(await classifyContainer(container("job", { "dev.reaper.owner-pid": "4242" }), s)).toBe(
      "dead owner-pid=4242 (label)",
    );
    expect(await classifyContainer(container("private-repo-ci-postgres-5151", {}), s)).toBe(
      "dead owner-pid=5151 (name)",
    );
    expect(
      await classifyContainer(container("job", { "dev.reaper.owner-pid": "7" }), s),
    ).toBeNull();
    expect(await classifyContainer(container("my-db", {}), s)).toBeNull();
  });

  it("never reaps compose, keep-labelled, restart-policy, young or foreign-owner containers", async () => {
    const s = scope();
    const dead = { "dev.reaper.owner-pid": "4242" };
    expect(
      await classifyContainer(
        container("a", { ...dead, "com.docker.compose.project": "stack" }),
        s,
      ),
    ).toBeNull();
    expect(
      await classifyContainer(container("b", { ...dead, "dev.reaper.keep": "1" }), s),
    ).toBeNull();
    expect(
      await classifyContainer(container("c", { ...dead, "private-repo.keep-db": "true" }), s),
    ).toBeNull();
    expect(
      await classifyContainer(
        container("d", dead, { HostConfig: { RestartPolicy: { Name: "unless-stopped" } } }),
        s,
      ),
    ).toBeNull();
    expect(await classifyContainer(container("e", dead, { Created: YOUNG }), s)).toBeNull();
    expect(
      await classifyContainer(
        container("f", { ...dead, "dev.reaper.owner-host": "laptop.local" }),
        s,
      ),
    ).toBeNull();
    expect(
      await classifyContainer(container("g", { ...dead, "dev.reaper.owner-ns": "pid:[1]" }), s),
    ).toBeNull();
  });

  it("on a shared Docker Desktop daemon, trusts only fully scoped owner labels", async () => {
    const s = scope({ sharedDaemon: true });
    expect(await classifyContainer(container("private-repo-ci-redis-4242", {}), s)).toBeNull();
    expect(
      await classifyContainer(container("a", { "dev.reaper.owner-pid": "4242" }), s),
    ).toBeNull();
    expect(
      await classifyContainer(
        container("b", {
          "dev.reaper.owner-pid": "4242",
          "dev.reaper.owner-host": "workstation",
          "dev.reaper.owner-ns": "pid:[4026531836]",
        }),
        s,
      ),
    ).toBe("dead owner-pid=4242 (label)");
  });

  it("reaps a container whose checkout was deleted, never one on an unmounted parent", async () => {
    const parent = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-docker-co-")),
    );
    cleanups.push(() => NodeFS.rmSync(parent, { recursive: true, force: true }));
    const live = NodePath.join(parent, "live");
    NodeFS.mkdirSync(live);
    const s = scope();
    const gone = NodePath.join(parent, "gone");
    expect(await classifyContainer(container("a", { "dev.devdeck.checkout": gone }), s)).toBe(
      `deleted checkout ${gone}`,
    );
    expect(await classifyContainer(container("b", { "dev.devdeck.checkout": live }), s)).toBeNull();
    const unmounted = NodePath.join(parent, "no-such-mount", "repo");
    expect(
      await classifyContainer(container("c", { "dev.devdeck.checkout": unmounted }), s),
    ).toBeNull();
  });

  it("keeps networks that have containers or compose labels", () => {
    const s = scope();
    const net = (name: string, extra: Record<string, unknown> = {}) => ({
      Id: `n-${name}`,
      Name: name,
      Created: OLD,
      Labels: {},
      Containers: {},
      ...extra,
    });
    expect(classifyNetwork(net("private-repo-ci-smoke-4242"), s)).toBe("dead owner-pid=4242 (name)");
    expect(classifyNetwork(net("private-repo-ci-smoke-4242", { Containers: { abc: {} } }), s)).toBeNull();
    expect(
      classifyNetwork(
        net("app-ci-smoke-4242", { Labels: { "com.docker.compose.project": "x" } }),
        s,
      ),
    ).toBeNull();
    expect(classifyNetwork(net("bridge"), s)).toBeNull();
  });

  it("sends rm only for the stale container and network", async () => {
    const calls: string[][] = [];
    const inspect = [
      container("stale", { "dev.reaper.owner-pid": "4242" }),
      container("kept", { "dev.reaper.owner-pid": "4242", "com.docker.compose.project": "app" }),
    ];
    const networks = [
      { Id: "n1", Name: "private-repo-proxy-test-5151", Created: OLD, Labels: {}, Containers: {} },
      { Id: "n2", Name: "team-net", Created: OLD, Labels: {}, Containers: {} },
    ];
    const run: DockerRunner = async (args) => {
      calls.push([...args]);
      const [a, b] = args;
      if (a === "info") return { code: 0, stdout: "Ubuntu 26.04 LTS\n" };
      if (a === "ps") return { code: 0, stdout: "id-stale\nid-kept\n" };
      if (a === "inspect") return { code: 0, stdout: JSON.stringify(inspect) };
      if (a === "network" && b === "ls")
        return { code: 0, stdout: "n1\tsilo-proxy-test-5151\nn0\tbridge\nn2\tteam-net\n" };
      if (a === "network" && b === "inspect") return { code: 0, stdout: JSON.stringify(networks) };
      return { code: 0, stdout: "" };
    };
    const { sharedDaemon: _shared, ...base } = scope();

    const removed = await reapDocker(base, { dryRun: false, log: () => undefined, run });

    expect(removed).toEqual({ containers: 1, networks: 1 });
    const removals = calls.filter((c) => c[0] === "rm" || (c[0] === "network" && c[1] === "rm"));
    expect(removals).toEqual([
      ["rm", "-fv", "id-stale"],
      ["network", "rm", "n1"],
    ]);
  });
});
