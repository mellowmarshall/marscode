// @effect-diagnostics nodeBuiltinImport:off - CI services against this host's real docker engine: a postgres container started, reached, and removed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { composeProjectPrefix, planCiServices, type CiServicePlan } from "./ciServicesPlan.ts";
import { localServiceShell, startCiServices, stopCiServices } from "./ciServicesRun.ts";
import { parseShipDeclaration } from "./declaration.ts";
import { readJob, readLog } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import type { RemoteCommandRunner } from "./sshExec.ts";
import { fixtureCleanups, makeFixture, sh } from "./testing/shipStepsFixture.ts";
import type { ProcessRunner, ShipQueueDeps } from "./types.ts";
import { runJob } from "./worker.ts";

/** A pinned image both CI hosts already hold; never `latest`. */
const PG_IMAGE = "postgres:17-alpine";

function dockerReady(): string | null {
  const engine = NodeChildProcess.spawnSync(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    {
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  if (engine.status !== 0) return "no docker engine answers on this host";
  const compose = NodeChildProcess.spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return compose.status === 0 ? null : "this host's docker has no compose plugin";
}
const SKIP = dockerReady();

const projectsLeft: string[] = [];
afterEach(() => {
  for (const p of projectsLeft.splice(0)) {
    NodeChildProcess.spawnSync(
      "docker",
      ["compose", "-p", p, "down", "-v", "--remove-orphans", "--timeout", "5"],
      {
        cwd: "/",
        timeout: 120_000,
      },
    );
  }
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
});

/** The CI host is this machine under its own HOME, as the remote CI test in shipSteps.test.ts. */
function remoteDeps(fx: ReturnType<typeof makeFixture>): ShipQueueDeps {
  const home = NodePath.join(fx.tmp, "ci-home");
  const hostClone = NodePath.join(home, "Dev", "sample-repo");
  NodeFS.mkdirSync(NodePath.dirname(hostClone), { recursive: true });
  sh(fx.tmp, [
    "clone",
    "-q",
    NodePath.join(fx.tmp, "remotes", "acme-fixture", "sample-repo.git"),
    hostClone,
  ]);
  const runRemote: RemoteCommandRunner = (_alias, script, options = {}) =>
    nodeProcessRunner({
      command: "bash",
      args: ["-c", script],
      cwd: home,
      // The docker CLI keeps its contexts in the real HOME; the engine is the same one.
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        DOCKER_CONFIG: NodePath.join(process.env.HOME ?? "", ".docker"),
      },
      replaceEnv: true,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
    });
  const run: ProcessRunner = (input) =>
    nodeProcessRunner({
      ...input,
      args: input.args.map((a) => a.replace(/^ssh:\/\/ci-1(?=\/)/, "")),
    });
  return {
    ...fx.deps,
    run,
    runRemote,
    ciPlacer: async () => ({
      kind: "remote",
      host: { name: "ci-1", ssh: "ci-1", role: "ci", data_root: NodePath.join(home, "data") },
      note: "ci host ci-1: room",
    }),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Postgres's SSLRequest: a live server answers one byte, `S` or `N`; a bare port proxy does not. */
async function postgresAnswers(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.setTimeout(10_000, () => socket.destroy(new Error("no answer within 10s")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.once("data", (data) => {
      socket.destroy();
      resolve(data.subarray(0, 1).toString("latin1"));
    });
  });
}

function projectContainers(project: string): string {
  const res = NodeChildProcess.spawnSync(
    "docker",
    ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`],
    { encoding: "utf8" },
  );
  return res.stdout.trim();
}

const COMPOSE = `services:
  postgres:
    image: ${PG_IMAGE}
    environment:
      POSTGRES_HOST_AUTH_METHOD: trust
    ports:
      - "127.0.0.1:\${SQ_PG_PORT:?set by ci.env}:5432"
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 1s
      timeout: 3s
      retries: 60
`;

describe.skipIf(SKIP !== null)(
  `CI services on real docker${SKIP ? ` (skipped: ${SKIP})` : ""}`,
  () => {
    it("starts postgres healthy on the declared port, stops a leftover project of the repo, and removes all of it", async () => {
      const fx = makeFixture({ declaration: "ship_ci_service=postgres\nship_ci_env=ci.env\n" });
      const port = await freePort();
      NodeFS.writeFileSync(NodePath.join(fx.primary, "compose.yaml"), COMPOSE);
      NodeFS.writeFileSync(NodePath.join(fx.primary, "ci.env"), `SQ_PG_PORT=${port}\n`);
      sh(fx.primary, ["add", "-A"]);
      sh(fx.primary, ["commit", "-q", "-m", "services"]);
      const decl = parseShipDeclaration(
        NodeFS.readFileSync(NodePath.join(fx.primary, ".tree-guard.conf"), "utf8"),
      );
      const plan = async (jobId: string): Promise<CiServicePlan> => {
        const planned = await planCiServices({
          run: nodeProcessRunner,
          worktree: fx.primary,
          tip: "HEAD",
          repo: "svc-test-repo",
          jobId,
          decl,
        });
        if (!planned.ok || !planned.plan) throw new Error(`no plan: ${JSON.stringify(planned)}`);
        projectsLeft.push(planned.plan.project);
        return planned.plan;
      };
      const shell = localServiceShell(nodeProcessRunner, fx.primary);
      const log: string[] = [];

      const first = await plan("9001");
      expect(await startCiServices(shell, first, (t) => log.push(t))).toMatchObject({
        kind: "up",
        services: ["postgres"],
      });
      expect(["S", "N"]).toContain(await postgresAnswers(port));
      expect(projectContainers(first.project)).not.toBe("");

      // A job the worker lost left its project; the next job of the repo takes the same fixed port.
      const second = await plan("9002");
      const started = await startCiServices(shell, second, (t) => log.push(t));
      expect(started).toMatchObject({
        kind: "up",
        env: { SHIP_QUEUE_CI_COMPOSE_PROJECT: second.project },
      });
      expect(projectContainers(first.project)).toBe("");
      expect(log.join("\n")).toContain(`stopped the leftover services project ${first.project}`);
      expect(["S", "N"]).toContain(await postgresAnswers(port));

      await stopCiServices(shell, second, (t) => log.push(t));
      expect(projectContainers(second.project)).toBe("");
      const volumes = NodeChildProcess.spawnSync(
        "docker",
        ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${second.project}`],
        { encoding: "utf8" },
      );
      expect(volumes.stdout.trim()).toBe("");
    });

    it.each(["local", "remote"] as const)(
      "runs a %s job whose CI step reaches postgres through ship_ci_env's port, then removes the project",
      async (where) => {
        const fx = makeFixture({ declaration: "ship_ci_service=postgres\nship_ci_env=ci.env\n" });
        const port = await freePort();
        NodeFS.writeFileSync(NodePath.join(fx.primary, "compose.yaml"), COMPOSE);
        NodeFS.writeFileSync(NodePath.join(fx.primary, "ci.env"), `SQ_PG_PORT=${port}\n`);
        NodeFS.writeFileSync(
          NodePath.join(fx.primary, "scripts", "ship", "steps.sh"),
          `#!/usr/bin/env bash
case "$1" in
  body) grep -q "Closes #" "$2" ;;
  install) echo "install sees \${SHIP_QUEUE_CI_SERVICES:-none}" ;;
  ci)
    exec 3<>"/dev/tcp/127.0.0.1/$SQ_PG_PORT" || exit 7
    printf '\\000\\000\\000\\010\\004\\322\\026\\057' >&3
    r=$(head -c1 <&3)
    case "$r" in S|N) echo "postgres answered $r on $SQ_PG_PORT in $SHIP_QUEUE_CI_COMPOSE_PROJECT" ;; *) echo "no postgres answer"; exit 8 ;; esac ;;
esac
`,
        );
        sh(fx.primary, ["add", "-A"]);
        sh(fx.primary, ["commit", "-q", "-m", "services"]);
        sh(fx.primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
        const deps = where === "remote" ? remoteDeps(fx) : fx.deps;
        const wt = fx.worktree(`feat/149-docker-${where}`, { "d.txt": "d\n" });
        const id = await fx.submit(wt, `feat/149-docker-${where}`, deps);
        const project = `${composeProjectPrefix(readJob(fx.root, id)!.repo)}${id}`;
        projectsLeft.push(project);

        expect(await runJob(deps, id)).toBe("ended");

        const job = readJob(fx.root, id);
        expect(job?.state).toBe("done");
        const host = where === "remote" ? "ci-1" : "local";
        expect(job?.steps?.filter((s) => s.name !== "ship_body_check").map((s) => s.host)).toEqual([
          host,
          host,
        ]);
        const output = NodeFS.readFileSync(
          NodePath.join(fx.root, "jobs", id, "ci-output.txt"),
          "utf8",
        );
        expect(output).toContain("install sees postgres");
        expect(output).toMatch(new RegExp(`postgres answered [SN] on ${port} in ${project}`));
        expect(readLog(fx.root, id)).toContain(`stopped the services (compose project ${project})`);
        expect(projectContainers(project)).toBe("");
      },
    );
  },
);
