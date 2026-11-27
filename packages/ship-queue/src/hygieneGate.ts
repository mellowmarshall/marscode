// @effect-diagnostics nodeBuiltinImport:off globalDate:off - House hygiene stage (PLAYBOOK §16): public-repo scan and its evidence receipt.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  buildHygieneReceipt,
  detectLayers,
  displayPath,
  formatFinding,
  fullScan,
  loadDenylist,
  readPolicyFile,
  treeOf,
  writeReceipt,
  type DenyRule,
} from "@t3tools/hygiene";

import { parseShipDeclaration } from "./declaration.ts";
import { gitOut } from "./gitQueries.ts";
import { jobDir, jobEvidenceDir } from "./jobStore.ts";
import { isPrivateVisibility, readRepoVisibility } from "./repoVisibility.ts";
import type { HygieneGate, HygieneVerdict, ProcessRunner } from "./types.ts";

const PROBE_TIMEOUT_MS = 30_000;

async function hasTextGuard(run: ProcessRunner, cwd: string): Promise<boolean> {
  try {
    const res = await run({
      command: "marscode-host-guard",
      args: ["capabilities"],
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return res.exitCode === 0 && res.stdout.split("\n").some((l) => l.includes("text-guard"));
  } catch {
    return false;
  }
}

function scanJob(
  worktree: string,
  baseSha: string,
  denylist: ReadonlyArray<DenyRule>,
  title: string,
  body: string,
) {
  try {
    const policy = readPolicyFile(worktree);
    const scan = fullScan({
      root: worktree,
      baseSha,
      denylist,
      policy,
      githubTexts: [
        { source: "pr-title", text: title },
        { source: "pr-body", text: body },
      ],
    });
    return { kind: "ok" as const, scan, policy };
  } catch (cause) {
    return {
      kind: "error" as const,
      why: cause instanceof Error ? cause.constructor.name : "error",
    };
  }
}

function fail(reason: string, lines: ReadonlyArray<string>): HygieneVerdict {
  return { kind: "fail", reason, log: lines.join("\n") };
}

/**
 * The §16 house stage. A public repo (or one whose visibility cannot be read) is scanned over
 * its tree, `base..HEAD`, commit metadata, and the PR title and body, with the host-local
 * denylist mandatory; a pass writes the hygiene receipt. Logs carry class ids and locations only.
 */
export function scannerHygieneGate(
  run: ProcessRunner,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HygieneGate {
  return async (input) => {
    const work = NodePath.join(jobDir(input.queueRoot, input.jobId), "work");
    const conf =
      (await gitOut(run, input.worktree, ["show", `${input.baseSha}:.tree-guard.conf`])) ?? "";
    const slug = parseShipDeclaration(conf).ghRepo || input.repo;
    const visibility = await readRepoVisibility(
      run,
      input.worktree,
      slug,
      NodePath.join(work, "hygiene-visibility"),
    );
    if (isPrivateVisibility(visibility)) {
      return { kind: "skip", log: `house hygiene: skipped (${slug} is ${visibility})` };
    }
    const scope = visibility === "public" ? "public" : "visibility unknown, scanned as public";
    const denylist = loadDenylist(env);
    if (denylist.kind !== "loaded") {
      const where = displayPath(denylist.path, env);
      return fail(`house_hygiene_denylist_${denylist.kind}`, [
        `house hygiene (${scope}): the private denylist at ${where} is ${denylist.kind}; the ship gate requires it (PLAYBOOK §16.3/§16.5)`,
      ]);
    }
    let body = "";
    try {
      body = NodeFS.readFileSync(input.bodyFile, "utf8");
    } catch {
      body = "";
    }
    const scanned = scanJob(input.worktree, input.baseSha, denylist.rules, input.title, body);
    if (scanned.kind === "error") {
      return fail("house_hygiene_scan_error", [
        `house hygiene (${scope}): scan failed (${scanned.why})`,
      ]);
    }
    const { scan, policy } = scanned;
    if (scan.findings.length > 0) {
      const classes = [...new Set(scan.findings.map((f) => f.classId))].toSorted();
      return fail(`house_hygiene classes=${classes.join(",")}`, [
        `house hygiene (${scope}): ${scan.findings.length} finding(s)`,
        ...scan.findings.map(formatFinding),
      ]);
    }
    const textGuard = await hasTextGuard(run, input.worktree);
    const receipt = buildHygieneReceipt({
      tree: treeOf(input.worktree, "HEAD"),
      jobId: input.jobId,
      generatedAt: new Date().toISOString(),
      run: scan,
      layers: detectLayers(input.worktree, "HEAD", { shipGate: true, textGuard: () => textGuard }),
      policy,
    });
    writeReceipt(
      NodePath.join(jobEvidenceDir(input.queueRoot, input.jobId), "hygiene.json"),
      receipt,
    );
    const layers = receipt.measurements.layers;
    return {
      kind: "pass",
      log: `house hygiene (${scope}): clean in ${scan.durationMs}ms; receipt layers=${Array.isArray(layers) ? layers.join(",") : ""}`,
    };
  };
}
