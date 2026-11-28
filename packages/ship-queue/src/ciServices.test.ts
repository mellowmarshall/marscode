// @effect-diagnostics nodeBuiltinImport:off - CI services: the declaration's plan, image pins, routing's docker need, step env, and teardown on failure.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { validateCiHostsManifest } from "./ciHosts.ts";
import { qualifyCiHosts } from "./ciRouter.ts";
import {
  isPinnedImage,
  mergeServiceLists,
  planCiServices,
  selectStartedServices,
  serviceToolSpecs,
  unpinnedServiceImages,
  composeConfigServices,
  composeProjectPrefix,
  type CiServicePlan,
} from "./ciServicesPlan.ts";
import { startCiServices, stopCiServices, type ServiceShell } from "./ciServicesRun.ts";
import { wrapArgvWithCiEnv } from "./ciEnvFile.ts";
import { parseShipDeclaration } from "./declaration.ts";
import { readJob, readLog } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { buildLocalStepEnv, buildRemoteStepScript, type StepJobContext } from "./stepRunner.ts";
import { fixtureCleanups, makeFixture, sh } from "./testing/shipStepsFixture.ts";
import type { ProcessResult, ProcessRunner, ShipQueueDeps } from "./types.ts";
import { runJob } from "./worker.ts";

afterEach(() => {
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
});

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });

const PLAN: CiServicePlan = {
  project: "sq-sample-repo-1001",
  projectPrefix: "sq-sample-repo-",
  composeFiles: ["compose.yaml"],
  required: ["postgres", "redis"],
  optional: [],
  added: [],
  envFile: "ci.env",
};

describe("ship_ci_service declaration", () => {
  it("parses repeated services and ship_ci_env from .tree-guard.conf and playbook.json", () => {
    const decl = parseShipDeclaration(
      "ship_ci_service=postgres\nship_ci_service=redis\nship_ci_service=postgres\nship_ci_env=ci/ci.env\n",
    );
    expect(decl.ciServices).toEqual(["postgres", "redis"]);
    expect(decl.ciEnv).toBe("ci/ci.env");
    expect(parseShipDeclaration("ship_ci_env=/etc/passwd\n").ciEnv).toBe("");
    expect(parseShipDeclaration("ship_ci_env=../x.env\n").ciEnv).toBe("");
  });

  it("keeps the base's services as the floor and adds the branch's (the legacy rule)", () => {
    expect(mergeServiceLists(["postgres", "redis"], ["postgres", "minio"])).toEqual({
      ok: true,
      required: ["postgres", "minio"],
      optional: ["redis"],
      added: ["minio"],
    });
    expect(mergeServiceLists(["bad name"], [])).toMatchObject({ ok: false });
    // A dropped base service starts while compose still has it; a required one must be there.
    const plan = { ...PLAN, required: ["postgres"], optional: ["redis"] };
    expect(selectStartedServices(plan, new Set(["postgres", "redis"]))).toEqual({
      ok: true,
      services: ["postgres", "redis"],
    });
    expect(selectStartedServices(plan, new Set(["postgres"]))).toEqual({
      ok: true,
      services: ["postgres"],
    });
    expect(selectStartedServices(plan, new Set(["redis"]))).toMatchObject({ ok: false });
  });

  it("refuses an unpinned image of a started service or its dependency, never a built one", () => {
    expect(isPinnedImage("postgres:17-alpine")).toBe(true);
    expect(isPinnedImage("registry.local:5000/team/redis:7.4")).toBe(true);
    expect(isPinnedImage(`redis@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isPinnedImage("postgres")).toBe(false);
    expect(isPinnedImage("postgres:latest")).toBe(false);
    expect(isPinnedImage("registry.local:5000/redis")).toBe(false);
    const services = composeConfigServices({
      services: {
        api: { build: { context: "." }, depends_on: { db: { condition: "service_healthy" } } },
        db: { image: "postgres" },
        cache: { image: "redis:7-alpine" },
        dev: { image: "mailhog:latest" },
      },
    });
    expect(unpinnedServiceImages(services, ["api", "cache"])).toEqual(["db (postgres)"]);
    expect(unpinnedServiceImages(services, ["cache"])).toEqual([]);
  });

  it("plans the project, compose files and branch additions at the job's tip", async () => {
    const fx = makeFixture({ declaration: "ship_ci_service=postgres\nship_ci_env=ci.env\n" });
    const wt = fx.worktree("feat/149-plan", {
      "compose.yaml": "services: {}\n",
      "compose.override.yml": "services: {}\n",
      ".tree-guard.conf": `${NodeFS.readFileSync(NodePath.join(fx.primary, ".tree-guard.conf"), "utf8")}ship_ci_service=redis\n`,
    });
    const tip = sh(wt, ["rev-parse", "HEAD"]);
    const decl = parseShipDeclaration(
      NodeFS.readFileSync(NodePath.join(fx.primary, ".tree-guard.conf"), "utf8"),
    );
    const planned = await planCiServices({
      run: nodeProcessRunner,
      worktree: wt,
      tip,
      repo: "Sample.Repo",
      jobId: "1001",
      decl,
    });
    expect(planned).toEqual({
      ok: true,
      plan: {
        project: `${composeProjectPrefix("Sample.Repo")}1001`,
        projectPrefix: composeProjectPrefix("Sample.Repo"),
        composeFiles: ["compose.yaml", "compose.override.yml"],
        required: ["postgres", "redis"],
        optional: [],
        added: ["redis"],
        envFile: "ci.env",
      },
    });
    const bare = await planCiServices({
      run: nodeProcessRunner,
      worktree: fx.primary,
      tip: "HEAD",
      repo: "sample-repo",
      jobId: "1002",
      decl,
    });
    expect(bare).toMatchObject({ ok: false });
    if (!bare.ok) expect(bare.reason).toContain("it commits no compose file");
  });
});

describe("routing for a job with services", () => {
  it("never picks a host without docker for a job that starts services", () => {
    const manifest = validateCiHostsManifest({
      schema: 1,
      hosts: [
        { name: "hub", ssh: null, role: "ci", priority: 3, data_root: "~/data" },
        { name: "no-docker", ssh: "a.example", role: "ci", priority: 1, data_root: "~/data" },
        { name: "with-docker", ssh: "b.example", role: "ci", priority: 2, data_root: "~/data" },
      ],
      toolchain: {
        git: { version: ">=2.40", probe: "git --version", install: null, base: true },
        docker: { version: ">=24", probe: "docker version", install: null },
        "docker-compose": { version: ">=2", probe: "docker compose version", install: null },
      },
    }).manifest!;
    const probesByHost = {
      hub: { __os: "linux", __arch: "x86_64", git: "2.43.0" },
      "no-docker": { __os: "linux", __arch: "x86_64", git: "2.43.0" },
      "with-docker": {
        __os: "linux",
        __arch: "aarch64",
        git: "2.43.0",
        docker: "29.1.3",
        "docker-compose": "2.40.3",
      },
    };
    expect(serviceToolSpecs(["git"], [])).toEqual(["git"]);
    expect(serviceToolSpecs(["docker@>=27"], ["postgres"])).toEqual([
      "docker@>=27",
      "docker-compose",
    ]);
    const queueRoot = NodeFS.mkdtempSync(
      NodePath.join(process.env.TMPDIR ?? "/tmp", "sq-svc-route-"),
    );
    try {
      const plain = qualifyCiHosts({ queueRoot, manifest, probesByHost, requiredTools: [] });
      expect(plain.qualified.map((h) => h.name)).toEqual(["hub", "no-docker", "with-docker"]);
      const services = qualifyCiHosts({
        queueRoot,
        manifest,
        probesByHost,
        requiredTools: serviceToolSpecs([], ["postgres", "redis"]),
      });
      expect(services.qualified.map((h) => h.name)).toEqual(["with-docker"]);
    } finally {
      NodeFS.rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});

describe("services lifecycle", () => {
  const scripted = (answers: { config?: ProcessResult; up?: ProcessResult }) => {
    const calls: string[] = [];
    const shell: ServiceShell = async (script) => {
      if (script.includes(" up -d ")) {
        calls.push("up");
        return answers.up ?? ok("postgres 127.0.0.1:15432->5432/tcp\n");
      }
      if (script.includes(" config --format json")) {
        calls.push("config");
        return (
          answers.config ??
          ok(
            JSON.stringify({
              services: {
                postgres: { image: "postgres:17-alpine" },
                redis: { image: "redis:7-alpine" },
              },
            }),
          )
        );
      }
      if (script.includes(" down -v ")) {
        calls.push("down");
        return ok();
      }
      throw new Error(`unexpected script ${script}`);
    };
    return { calls, shell };
  };

  it("starts the services and gives the steps the project and service names", async () => {
    const { calls, shell } = scripted({});
    const log: string[] = [];
    const res = await startCiServices(shell, PLAN, (t) => log.push(t));
    expect(res).toEqual({
      kind: "up",
      services: ["postgres", "redis"],
      env: {
        SHIP_QUEUE_CI_SERVICES: "postgres redis",
        SHIP_QUEUE_CI_COMPOSE_PROJECT: "sq-sample-repo-1001",
      },
    });
    expect(calls).toEqual(["config", "up"]);
    expect(log.join("\n")).toContain("services: postgres 127.0.0.1:15432->5432/tcp");
  });

  it("refuses a service the compose configuration lacks, and an unpinned image, before any start", async () => {
    const missing = scripted({
      config: ok(JSON.stringify({ services: { postgres: { image: "postgres:17" } } })),
    });
    expect(await startCiServices(missing.shell, PLAN, () => {})).toMatchObject({ kind: "refused" });
    expect(missing.calls).toEqual(["config"]);
    const latest = scripted({
      config: ok(
        JSON.stringify({
          services: { postgres: { image: "postgres:latest" }, redis: { image: "redis" } },
        }),
      ),
    });
    const res = await startCiServices(latest.shell, PLAN, () => {});
    expect(res).toMatchObject({ kind: "refused" });
    if (res.kind === "refused")
      expect(res.reason).toContain("postgres (postgres:latest), redis (redis)");
    const badFile = scripted({
      config: { exitCode: 4, stdout: "", stderr: "the declared env file" },
    });
    expect(await startCiServices(badFile.shell, PLAN, () => {})).toMatchObject({ kind: "refused" });
    const noCompose = scripted({
      config: { exitCode: 5, stdout: "", stderr: "no docker compose" },
    });
    expect(await startCiServices(noCompose.shell, PLAN, () => {})).toMatchObject({
      kind: "failed",
    });
  });

  it("starts nothing when no declared service is left, and never runs a bare compose up", async () => {
    // Only optional services, and the compose configuration has none of them.
    const { calls, shell } = scripted({
      config: ok(JSON.stringify({ services: { other: { image: "busybox:1.36" } } })),
    });
    const log: string[] = [];
    const res = await startCiServices(
      shell,
      { ...PLAN, required: [], optional: ["postgres"], added: [] },
      (t) => log.push(t),
    );
    expect(res).toMatchObject({ kind: "up", services: [] });
    expect(calls).toEqual(["config"]);
    expect(log).toEqual(["no declared service is left to start"]);
  });

  it("keeps apart the projects of repos whose names differ only in punctuation", () => {
    const dotted = composeProjectPrefix("acme/app.api");
    const dashed = composeProjectPrefix("acme/app-api");
    expect(dotted).toMatch(/^sq-acme-app-api-[0-9a-f]{8}-$/);
    expect(dashed).toMatch(/^sq-acme-app-api-[0-9a-f]{8}-$/);
    expect(dotted).not.toBe(dashed);
    expect(composeProjectPrefix("Acme/App.Api")).toBe(dotted);
  });

  it("stops a start that failed its health wait", async () => {
    const { calls, shell } = scripted({
      up: { exitCode: 1, stdout: "", stderr: "container sq-x-postgres-1 is unhealthy" },
    });
    const res = await startCiServices(shell, PLAN, () => {});
    expect(res).toMatchObject({ kind: "failed" });
    if (res.kind === "failed") expect(res.reason).toContain("is unhealthy");
    expect(calls).toEqual(["config", "up", "down"]);
    const log: string[] = [];
    await stopCiServices(
      async () => ({ exitCode: 1, stdout: "", stderr: "engine gone" }),
      PLAN,
      (t) => log.push(t),
    );
    expect(log).toEqual(["could not stop compose project sq-sample-repo-1001: engine gone"]);
  });
});

/**
 * A fixture repo whose base declares postgres and an env file; `config` is what compose reads on
 * the host. The engine answers through the services shell; every step runs for real.
 */
function servicesJob(configServices: Record<string, unknown>) {
  const fx = makeFixture({ declaration: "ship_ci_service=postgres\nship_ci_env=ci.env\n" });
  NodeFS.writeFileSync(
    NodePath.join(fx.primary, "compose.yaml"),
    "services:\n  postgres:\n    image: postgres:17-alpine\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(fx.primary, "ci.env"),
    "SQ_PG_PORT=15432\nexport PATH=/nowhere\n",
  );
  sh(fx.primary, ["add", "-A"]);
  sh(fx.primary, ["commit", "-q", "-m", "services"]);
  sh(fx.primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  const order: string[] = [];
  // The engine answers through the services shell; every step runs for real.
  const run: ProcessRunner = async (input) => {
    const script = input.command === "bash" && input.args[0] === "-c" ? (input.args[1] ?? "") : "";
    if (script.includes("docker compose")) {
      if (script.includes(" up -d ")) {
        order.push("up");
        return ok("postgres 127.0.0.1:15432->5432/tcp\n");
      }
      if (script.includes(" config --format json")) {
        order.push("config");
        return ok(JSON.stringify({ services: configServices }));
      }
      if (script.includes(" down -v ")) {
        order.push("down");
        return ok();
      }
    }
    const step = input.args.find((a) => ["install", "ci"].includes(a));
    if (step && input.args.some((a) => a.endsWith("steps.sh"))) order.push(step);
    return nodeProcessRunner(input);
  };
  const deps: ShipQueueDeps = { ...fx.deps, run };
  return { fx, deps, order };
}

describe("services and env in a job's steps", () => {
  it("starts services before install, gives steps the env file and service names, and stops them after a failed CI", async () => {
    const { fx, deps, order } = servicesJob({ postgres: { image: "postgres:17-alpine" } });
    const wt = fx.worktree("feat/149-services", { "ci-fail": "1\n" });
    const id = await fx.submit(wt, "feat/149-services", deps);

    expect(await runJob(deps, id)).toBe("ended");

    expect(readJob(fx.root, id)).toMatchObject({
      state: "failed",
      reason: "ci step=ship_ci exit=3",
    });
    expect(order).toEqual(["config", "up", "install", "ci", "down"]);
    const log = readLog(fx.root, id);
    expect(log).toMatch(new RegExp(`compose project sq-[a-z-]*sample-repo-[0-9a-f]{8}-${id}\\b`));
    expect(log).not.toContain("UNPROVEN: ship_ci_service");
    expect(log).not.toContain("UNPROVEN: ship_ci_env");
    const output = NodeFS.readFileSync(NodePath.join(fx.root, "jobs", id, "ci-output.txt"), "utf8");
    expect(output).toContain("SQ_PG_PORT");
    expect(output).toContain("SHIP_QUEUE_CI_SERVICES");
    expect(output).toContain("SHIP_QUEUE_CI_COMPOSE_PROJECT");
  });

  it("fails a job whose compose configuration lacks a declared service, with no step run", async () => {
    const { fx, deps, order } = servicesJob({ redis: { image: "redis:7-alpine" } });
    const wt = fx.worktree("feat/149-noservice", { "n.txt": "n\n" });
    const id = await fx.submit(wt, "feat/149-noservice", deps);

    expect(await runJob(deps, id)).toBe("ended");

    const job = readJob(fx.root, id)!;
    expect(job.state).toBe("failed");
    expect(job.reason).toContain("ci_services the declared service postgres is not a service");
    expect(order).toEqual(["config", "down"]);
    expect(readLog(fx.root, id)).toContain("=== ci-services:");
  });

  it("reads the env file as data in a local step without replacing the queue's own names", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(process.env.TMPDIR ?? "/tmp", "sq-ci-env-"));
    try {
      const file = NodePath.join(dir, "ci.env");
      NodeFS.writeFileSync(
        file,
        "DATABASE_URL=postgres://127.0.0.1:15432/ci\nSHIP_QUEUE_JOB=evil\n",
      );
      const argv = wrapArgvWithCiEnv(file, ["bash", "-c", 'echo "$DATABASE_URL $SHIP_QUEUE_JOB"']);
      const res = await nodeProcessRunner({
        command: argv[0]!,
        args: argv.slice(1),
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", SHIP_QUEUE_JOB: "1001" },
        replaceEnv: true,
      });
      expect(res.stdout.trim()).toBe("postgres://127.0.0.1:15432/ci 1001");
      // The file comes from the branch: it is read as data and never run. A command line, or a
      // value that would expand, stops the step, so it cannot end the shell before the CI command.
      const marker = NodePath.join(dir, "ran");
      const hostileFiles = [
        "A=1\nexit 0\n",
        `A=$(touch ${marker})\n`,
        'A="x$HOME"\n',
        // The reader's own names: no line may change what the reader runs.
        `sq_keep="touch ${marker}"\n`,
        "sq_set=.*\n",
        "IFS=x\n",
      ];
      for (const text of hostileFiles) {
        NodeFS.writeFileSync(file, text);
        const hostile = wrapArgvWithCiEnv(file, ["bash", "-c", "echo ci-ran"]);
        const refused = await nodeProcessRunner({
          command: hostile[0]!,
          args: hostile.slice(1),
          cwd: dir,
        });
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout).not.toContain("ci-ran");
        expect(refused.stderr).toMatch(
          /has a line that is not NAME=value|sets a name it may not set/,
        );
      }
      expect(NodeFS.existsSync(marker)).toBe(false);
      // What real env files hold: comments, export, unset, quoted literals.
      NodeFS.writeFileSync(
        file,
        "# ports\nunset OLD_A OLD_B\nexport PG_PORT=15432\nNAME='a b'\nURL=\"redis://127.0.0.1:16379\"\n",
      );
      const plain = wrapArgvWithCiEnv(file, ["bash", "-c", 'echo "$PG_PORT|$NAME|$URL"']);
      const loaded = await nodeProcessRunner({
        command: plain[0]!,
        args: plain.slice(1),
        cwd: dir,
      });
      expect(loaded.stdout.trim()).toBe("15432|a b|redis://127.0.0.1:16379");
      const gone = wrapArgvWithCiEnv(NodePath.join(dir, "none.env"), ["true"]);
      const missing = await nodeProcessRunner({ command: "bash", args: gone.slice(1), cwd: dir });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("is not in the job's tree");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives remote and local steps the services' env", () => {
    const ctx: StepJobContext = {
      jobId: "1001",
      repo: "sample-repo",
      primary: "/p",
      worktree: "/w",
      branch: "b",
      baseRef: "origin/main",
      baseSha: "a".repeat(40),
      queueRoot: "/q",
      stepTree: "/s",
      dataRoot: "",
      ciEnvFile: "ci.env",
      ciServiceEnv: { SHIP_QUEUE_CI_SERVICES: "postgres redis", "bad name": "x" },
    };
    const env = buildLocalStepEnv({ mode: "ci", ctx, baseEnv: { PATH: "/bin" } });
    expect(env.SHIP_QUEUE_CI_SERVICES).toBe("postgres redis");
    expect(env["bad name"]).toBeUndefined();
    const script = buildRemoteStepScript({
      remoteWorktree: "/r",
      remoteDataRootDeclared: "~/data",
      ctx,
      cmdline: "ci.sh",
    });
    expect(script).toContain("SHIP_QUEUE_CI_SERVICES='postgres redis'");
    expect(script).toContain("sq_f='./ci.env'");
    expect(script).not.toContain("bad name");
  });
});
