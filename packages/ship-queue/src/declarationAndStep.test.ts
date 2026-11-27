// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for declaration parsing, step execution, pass records, and Doppler broker.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { validateCiHostsManifest } from "./ciHosts.ts";
import { parseShipDeclaration } from "./declaration.ts";
import { extractBaseStepTree, validateShipDeclaration } from "./declarationValidation.ts";
import {
  formatSecretStdinPayload,
  mintDopplerTokens,
  readDopplerTokenRecords,
  revokeDopplerTokens,
  type DopplerHttpClient,
} from "./dopplerBroker.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import {
  createPassClaim,
  dumpPassClaims,
  findMatchingPassRecord,
  ingestPassClaims,
  toStoredPassRecord,
  validatePassClaim,
  writePassRecord,
} from "./passRecord.ts";
import {
  buildLocalStepEnv,
  buildRemoteStepScript,
  runLocalStep,
  runRemoteStep,
  shouldWithholdSecretsForStage,
} from "./stepRunner.ts";
import { buildToolchainShellSetup, formatDataRootShell } from "./toolchainEnv.ts";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("declaration parsing, validation, and base step-tree extraction", () => {
  it("parses .tree-guard.conf + playbook.json ship section and validates against ci-hosts manifest", () => {
    const confText = [
      "ship_repo=demo-app",
      "ship_gh_repo=example-org/demo-app",
      "ship_ci=scripts/ci.sh",
      "ship_merge_gate=scripts/merge.sh",
      "ship_ci_tool=node",
      "ship_ci_tool=vp",
      "ship_ci_secret=FLY_API_TOKEN",
      "ship_ci_doppler=demo/ci",
      "ship_ci_service=postgres",
      "ship_ci_path=cache/demo",
      "ship_ci_setting=web node@>=22",
      "ship_ci_needs=scripts/needs.sh",
      "ship_pass_record=ci",
      "ship_pass_record=merge",
    ].join("\n");

    const decl = parseShipDeclaration(confText);
    expect(decl.repo).toBe("demo-app");
    expect(decl.ghRepo).toBe("example-org/demo-app");
    expect(decl.ciTools).toEqual(["node", "vp"]);
    expect(decl.ciSecrets).toEqual(["FLY_API_TOKEN"]);
    expect(decl.ciDoppler).toEqual(["demo/ci"]);
    // Live vendor tokens prevent pass-record caching on ci while allowing recorded merge gate (which withholds secrets).
    expect(decl.passStages).toEqual(["merge"]);
    expect(decl.warnings.some((w) => w.includes("vendor tokens"))).toBe(true);
    expect(shouldWithholdSecretsForStage(decl, "merge")).toBe(true);
    expect(shouldWithholdSecretsForStage(decl, "ci")).toBe(false);

    const manifest = validateCiHostsManifest({
      schema: 1,
      hosts: [{ name: "local", ssh: null, role: "ci", data_root: "~/data" }],
      toolchain: {
        node: { version: ">=22", probe: "node -v", install: null, base: true },
        vp: { version: ">=0.1", probe: "vp --version", install: null },
      },
    }).manifest!;

    const valid = validateShipDeclaration(decl, {
      manifest,
      existingFiles: new Set([
        "scripts/ci.sh",
        "scripts/merge.sh",
        "scripts/needs.sh",
        "compose.yaml",
      ]),
    });
    expect(valid.ok).toBe(true);
    expect(valid.errors).toEqual([]);

    const bad = validateShipDeclaration(
      { ...decl, ciSecrets: ["UNALLOWED_SECRET"], ciPaths: ["/etc/shadow"] },
      { manifest },
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.includes("UNALLOWED_SECRET"))).toBe(true);
    expect(bad.errors.some((e) => e.includes("/etc/shadow"))).toBe(true);

    // Playbook §14 CI standards keys coexist with ship-queue routing keys without discarding ci.
    const mixed = parseShipDeclaration(
      "ship_repo=demo\nship_ci=scripts/ci.sh\n",
      JSON.stringify({
        contracts: { size: { evidence: ".playbook/evidence/size.json" } },
        ci: {
          tools: ["node"],
          settings: { web: ["pnpm"] },
          doppler: ["demo/ci"],
          arch: ["x86_64"],
          evidence: ".playbook/evidence/ci.json",
          parallel: 4,
          granularThresholdMs: 30_000,
          maxTier1Ms: 60_000,
          always: ["lint"],
          exceptions: [],
        },
      }),
    );
    expect(mixed.warnings).toEqual([]);
    expect(mixed.ciTools).toEqual(["node"]);
    expect(mixed.ciSettings).toEqual(["web pnpm"]);
    expect(mixed.ciDoppler).toEqual(["demo/ci"]);
    expect(mixed.ciArch).toEqual(["x86_64"]);
  });

  it("extracts pinned step scripts strictly from baseSha, refusing PR-only scripts", async () => {
    const repo = mkTempDir("sq-basetree-");
    const run = async (args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd: repo });
      if (r.exitCode !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    await run(["init", "-b", "main"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["config", "user.name", "Test User"]);
    NodeFS.mkdirSync(NodePath.join(repo, "scripts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, "scripts", "ci.sh"), "echo from-base\n");
    await run(["add", "scripts/ci.sh"]);
    await run(["commit", "-m", "base"]);
    const baseSha = await run(["rev-parse", "HEAD"]);

    // Add a PR-only script not present in baseSha.
    NodeFS.writeFileSync(NodePath.join(repo, "scripts", "pr-only.sh"), "echo evil\n");
    const decl = parseShipDeclaration("ship_repo=demo\nship_ci=scripts/ci.sh\n");
    const outDir = mkTempDir("sq-baseout-");
    const extracted = await extractBaseStepTree({
      primary: repo,
      baseSha,
      decl,
      destDir: outDir,
      run: nodeProcessRunner,
    });
    expect(extracted.ok).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(outDir, "scripts", "ci.sh"), "utf8")).toContain(
      "from-base",
    );
    expect(NodeFS.existsSync(NodePath.join(outDir, "scripts", "pr-only.sh"))).toBe(false);
  });
});

describe("local and remote step runner", () => {
  it("scrubs ambient secrets in ci mode, sets FLY_ACCESS_TOKEN alias, and runs declared scripts from base tree", async () => {
    const dir = mkTempDir("sq-step-");
    const stepTree = NodePath.join(dir, "base");
    const worktree = NodePath.join(dir, "wt");
    const queueRoot = NodePath.join(dir, "sq");
    NodeFS.mkdirSync(NodePath.join(stepTree, "scripts"), { recursive: true });
    NodeFS.mkdirSync(worktree, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stepTree, "scripts", "check.sh"),
      'printf "CF=%s FLY=%s ALIAS=%s DOP=%s\n" "${CLOUDFLARE_API_TOKEN:-}" "${FLY_API_TOKEN:-}" "${FLY_ACCESS_TOKEN:-}" "${DOPPLER_TOKEN_DEMO_CI:-}"\n',
    );

    const ctx = {
      jobId: "job-9",
      repo: "demo",
      primary: dir,
      worktree,
      branch: "feat/x",
      baseRef: "origin/main",
      baseSha: "b".repeat(40),
      queueRoot,
      stepTree,
      dataRoot: NodePath.join(dir, "data"),
    };

    const res = await runLocalStep({
      mode: "ci",
      ctx,
      cmdline: "scripts/check.sh",
      baseEnv: {
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: "ambient-leak",
        DOPPLER_TOKEN_DEMO_CI: "ambient-doppler",
      },
      secrets: { FLY_API_TOKEN: "fly-injected" },
      run: nodeProcessRunner,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("CF= FLY=fly-injected ALIAS=fly-injected DOP=");

    // When withholdSecrets=true, declared secrets are omitted too.
    const envWithheld = buildLocalStepEnv({
      mode: "ci",
      ctx,
      baseEnv: { PATH: "/usr/bin", FLY_API_TOKEN: "ambient" },
      secrets: { FLY_API_TOKEN: "injected" },
      withholdSecrets: true,
    });
    expect(envWithheld.FLY_API_TOKEN).toBeUndefined();
    expect(envWithheld.FLY_ACCESS_TOKEN).toBeUndefined();
    expect(envWithheld.PLAYBOOK_EVIDENCE_DIR).toBe(
      NodePath.join(queueRoot, "jobs", "job-9", "work", "playbook-evidence"),
    );
    expect(envWithheld.PLAYBOOK_EVIDENCE_JOB).toBe("job-9");
    expect(NodeFS.existsSync(envWithheld.PLAYBOOK_EVIDENCE_DIR!)).toBe(true);

    // Rejects scripts missing from stepTree.
    const missing = await runLocalStep({
      mode: "ci",
      ctx,
      cmdline: "scripts/not-in-base.sh",
      run: nodeProcessRunner,
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("not in the base tree");
  });

  it("passes remote CI secrets strictly via stdin and never in the remote bash script", async () => {
    const ctx = {
      jobId: "job-42",
      repo: "demo",
      primary: "/tmp/demo",
      worktree: "/tmp/wt",
      branch: "feat/remote",
      baseRef: "origin/main",
      baseSha: "c".repeat(40),
      queueRoot: "/tmp/sq",
      stepTree: "/tmp/base",
      dataRoot: "/tmp/data",
    };

    let capturedAlias = "";
    let capturedScript = "";
    let capturedStdin = "";
    const res = await runRemoteStep({
      sshAlias: "ci-host-1.example",
      remoteWorktree: "/home/ci/wt",
      remoteDataRootDeclared: "~/Dev-data",
      ctx,
      cmdline: "scripts/ci.sh --fast",
      secrets: { FLY_API_TOKEN: "super-secret-value" },
      runRemote: async (alias, script, options) => {
        capturedAlias = alias;
        capturedScript = script;
        capturedStdin = options?.stdin ?? "";
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    });
    expect(res.exitCode).toBe(0);
    expect(capturedAlias).toBe("ci-host-1.example");
    expect(capturedScript).not.toContain("super-secret-value");
    expect(capturedScript).toContain('PLAYBOOK_EVIDENCE_DIR="$sq_g/ship-queue-playbook-evidence"');
    expect(capturedScript).toContain("PLAYBOOK_EVIDENCE_JOB='job-42'");
    expect(capturedScript).toBe(
      buildRemoteStepScript({
        remoteWorktree: "/home/ci/wt",
        remoteDataRootDeclared: "~/Dev-data",
        ctx,
        cmdline: "scripts/ci.sh --fast",
      }),
    );
    expect(capturedStdin).toBe(formatSecretStdinPayload({ FLY_API_TOKEN: "super-secret-value" }));
    expect(capturedStdin).toContain("FLY_API_TOKEN=super-secret-value\n\n");
    // Remote wrapper scrubs the complete sensitive secret list before reading stdin.
    for (const secretVar of [
      "CLOUDFLARE_API_TOKEN",
      "DOPPLER_TOKEN",
      "FLY_API_TOKEN",
      "FLY_ACCESS_TOKEN",
      "HCLOUD_TOKEN",
      "NEON_API_KEY",
      "OP_SERVICE_ACCOUNT_TOKEN",
    ]) {
      expect(capturedScript).toContain(secretVar);
    }

    // Rejects unsafe remote script paths, unsafe data_root expressions, and CR/LF/NUL in secrets.
    expect(() =>
      buildRemoteStepScript({
        remoteWorktree: "/home/ci/wt",
        remoteDataRootDeclared: "~/Dev-data",
        ctx,
        cmdline: "",
      }),
    ).toThrow(/empty/);
    expect(() =>
      buildRemoteStepScript({
        remoteWorktree: "/home/ci/wt",
        remoteDataRootDeclared: "~/Dev-data",
        ctx,
        cmdline: "/etc/passwd",
      }),
    ).toThrow(/outside the base tree/);
    expect(() =>
      buildRemoteStepScript({
        remoteWorktree: "/home/ci/wt",
        remoteDataRootDeclared: "~/Dev-data",
        ctx,
        cmdline: "../escape.sh",
      }),
    ).toThrow(/outside the base tree/);
    expect(() => formatDataRootShell("~/data$(id)")).toThrow(/unsafe data_root/);
    expect(() => formatDataRootShell("/tmp/a;rm -rf /")).toThrow(/unsafe data_root/);
    expect(() => buildToolchainShellSetup({ dataRootShell: '$HOME/x"$(whoami)' })).toThrow(
      /unsafe dataRootShell/,
    );
    expect(() =>
      formatSecretStdinPayload({ FLY_API_TOKEN: "a\nCLOUDFLARE_API_TOKEN=evil" }),
    ).toThrow(/forbidden/);
    expect(() => formatSecretStdinPayload({ FLY_API_TOKEN: "a\rb" })).toThrow(/forbidden/);
    expect(() => formatSecretStdinPayload({ FLY_API_TOKEN: "a\0b" })).toThrow(/forbidden/);
  });
});

describe("pass record lifecycle", () => {
  it("creates, dumps, ingests, rejects clock skew, and matches stored pass records", () => {
    const queueRoot = mkTempDir("sq-pass-");
    const fixedNow = 1_700_000_000;
    const tree = "1".repeat(40);
    const context = "2".repeat(40);
    const claim = createPassClaim({
      repo: "demo",
      stage: "ci",
      tree,
      command: "scripts/ci.sh",
      context,
      excludes: ["docs/**"],
      tools: { node: "22.14.0", vp: "0.1.18" },
      nowEpochSec: fixedNow,
      reportText: "all checks green",
    });
    expect(validatePassClaim(claim)).toBeNull();

    const stored = toStoredPassRecord(claim, "ci-host-1");
    writePassRecord(queueRoot, stored, fixedNow);
    const found = findMatchingPassRecord(
      queueRoot,
      {
        repo: "demo",
        stage: "ci",
        tree,
        command: "scripts/ci.sh",
        context,
        excludes: ["docs/**"],
      },
      fixedNow + 60,
    );
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.record.host).toBe("ci-host-1");

    const outbox = mkTempDir("sq-pass-outbox-");
    writePassRecord(outbox, claim, fixedNow);
    const dumped = dumpPassClaims(outbox, fixedNow + 60);
    expect(dumped).toHaveLength(1);

    // Ingest into a fresh hub root: valid claim accepted, far-future skewed claim rejected.
    const hub2 = mkTempDir("sq-pass-hub2-");
    const skewedClaim = { ...claim, at: fixedNow + 10_000 };
    const ingested = ingestPassClaims({
      storeDir: hub2,
      host: "ci-host-2",
      lines: [JSON.stringify(claim), JSON.stringify(skewedClaim)],
      nowEpochSec: fixedNow + 10,
    });
    expect(ingested).toBe(1);
  });
});

describe("Doppler CI read-only token broker", () => {
  it("records tokens before returning, lists project configs, revokes on 404 idempotently, and cleans up partial mints", async () => {
    const dir = mkTempDir("sq-doppler-");
    const recordsPath = NodePath.join(dir, "doppler-tokens.json");
    const loginToken = "dp.pt.secret_login_token_value";
    const calls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown> | undefined;
    }> = [];

    const http: DopplerHttpClient = async ({ method, path, body }) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/v3/configs/config/tokens") {
        const cfg = String(body?.config ?? "");
        return {
          status: 200,
          body: {
            token: {
              slug: `slug-${cfg}`,
              key: `dp.st.${cfg}_key`,
              access: "read",
              expires_at: "2026-11-27T16:00:00Z",
            },
          },
        };
      }
      if (method === "GET" && path.startsWith("/v3/configs?")) {
        return { status: 200, body: { configs: [{ name: "ci" }, { name: "dev" }] } };
      }
      if (method === "DELETE") {
        return { status: 404, body: { messages: ["already gone"] } };
      }
      return { status: 500, body: {} };
    };

    const minted = await mintDopplerTokens({
      loginToken,
      jobId: "job-7",
      recordsPath,
      pairs: ["demo/ci"],
      nowEpochSec: 1_700_000_000,
      http,
    });
    expect(minted.envVars.DOPPLER_TOKEN_DEMO_CI).toBe("dp.st.ci_key");
    expect(minted.envVars.DOPPLER_CONFIGS_DEMO).toBe("ci,dev");
    expect(readDopplerTokenRecords(recordsPath)).toEqual([
      { project: "demo", config: "ci", slug: "slug-ci" },
    ]);

    // 404 counts as revoked and removes the records file.
    const revoked = await revokeDopplerTokens({ loginToken, recordsPath, http });
    expect(revoked.errors).toEqual([]);
    expect(NodeFS.existsSync(recordsPath)).toBe(false);

    // Partial mint failure revokes previously minted token and redacts loginToken from error messages.
    const deletedSlugs: string[] = [];
    let attempt = 0;
    const failingHttp: DopplerHttpClient = async ({ method, path, body }) => {
      if (method === "POST" && path === "/v3/configs/config/tokens") {
        attempt += 1;
        if (attempt === 1) {
          return {
            status: 200,
            body: {
              token: {
                slug: "slug-first",
                key: "dp.st.first_key",
                access: "read",
                expires_at: "2026-11-27T16:00:00Z",
              },
            },
          };
        }
        return { status: 403, body: { messages: [`rejected token ${loginToken}`] } };
      }
      if (method === "DELETE") {
        deletedSlugs.push(String(body?.slug ?? ""));
        return { status: 200, body: {} };
      }
      return { status: 200, body: {} };
    };

    let caughtMessage = "";
    try {
      await mintDopplerTokens({
        loginToken,
        jobId: "job-8",
        recordsPath,
        pairs: ["demo/ci", "demo/prod"],
        nowEpochSec: 1_700_000_000,
        http: failingHttp,
      });
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }
    expect(deletedSlugs).toEqual(["slug-first"]);
    expect(caughtMessage).not.toContain(loginToken);
    expect(caughtMessage).toContain("[REDACTED]");
  });
});
