// @effect-diagnostics nodeBuiltinImport:off - Headless CLI subcommands for `ship-queue hosts`, `ship-queue deps`, and `ship-queue pins`.
import * as NodePath from "node:path";

import { loadCiHostsManifest } from "./ciHosts.ts";
import { decideShipQueueDeps, listShipQueueDeps } from "./depsEngine.ts";
import { rollbackShipQueueDepsAttempt } from "./depsRollback.ts";
import { scanShipQueueDepsRepo } from "./depsScan.ts";
import { checkCiHosts, setCiHostAvailability, type HostExecDeps } from "./hostProbe.ts";
import { provisionCiHost, syncCiHostPayload } from "./hostProvision.ts";
import { buildRenovateCustomManagers, extractPinVersions, loadPinsSpec } from "./pins.ts";
import { collectRepoToolRequirements } from "./repoRequirements.ts";
import {
  checkHostsToolDrift,
  evaluateToolDrift,
  formatToolDriftReport,
  readCachedProbesByHost,
} from "./toolDrift.ts";
import { reconcileToolDrift } from "./toolDriftReconcile.ts";
import type { ShipQueueDeps } from "./types.ts";
import {
  pruneUnreferencedWorkerVersions,
  readCurrentWorkerVersion,
  stageWorkerVersion,
} from "./workerVersion.ts";

/** Tool states `hosts check` does not list per host: present, optional, or not for this platform. */
const QUIET_TOOL_STATES: ReadonlySet<string> = new Set(["ok", "optional", "not-for-host"]);

export interface SubcommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

export async function runHostsSubcommand(
  root: string,
  args: ReadonlyArray<string>,
  io: SubcommandIo,
  hostDeps?: HostExecDeps,
): Promise<number> {
  const [action, ...rest] = args;
  const manifestPath = io.env.SHIP_QUEUE_CI_HOSTS?.trim() || undefined;
  const usage =
    "ship-queue hosts <check [--json] [--drift] [HOST] | drift [--json] [--reconcile] [--force] [--repo REPO] [--source DIR] [--ref REF] | off NAME [--reason TEXT] | on NAME | provision HOST | sync HOST [--source DIR] [--ref REF] [--reconcile-tools]>\n";

  if (!action || action === "--help" || action === "-h") {
    io.stdout(usage);
    return 0;
  }

  // Manifest warnings (e.g. a host-local toolchain that hides the tracked catalog) reach the operator.
  for (const warning of loadCiHostsManifest({ overridePath: manifestPath }).warnings) {
    io.stderr(`ship-queue hosts: warning: ${warning}\n`);
  }

  if (action === "check") {
    const json = rest.includes("--json");
    const includeDrift = rest.includes("--drift");
    const targetHost = rest.find((a) => a !== "--json" && a !== "--drift");
    const res = await checkCiHosts({
      queueRoot: root,
      manifestPath,
      targetHost,
      deps: hostDeps,
    });
    if (!res.ok || !res.report) {
      io.stderr(`ship-queue hosts check: ${res.error ?? "failed"}\n`);
      return 2;
    }
    let driftReport = undefined;
    if (includeDrift) {
      const loaded = loadCiHostsManifest({ overridePath: manifestPath });
      if (loaded.ok && loaded.manifest) {
        const probes = readCachedProbesByHost(root, loaded.manifest);
        const repos = collectRepoToolRequirements({ queueRoot: root });
        driftReport = evaluateToolDrift({
          queueRoot: root,
          manifest: loaded.manifest,
          probesByHost: probes,
          repos,
          at: res.report.at,
        });
      }
    }
    if (json) {
      const payload = driftReport ? { ...res.report, tool_drift: driftReport } : res.report;
      io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      for (const h of res.report.hosts) {
        io.stdout(
          `${h.name} (${h.ssh ?? "this host"}): ${h.reached ? "reached" : "UNREACHABLE"}${h.ci_off ? " [OFF]" : ""}\n`,
        );
        for (const tool of h.tools.filter((t) => !QUIET_TOOL_STATES.has(t.state))) {
          io.stdout(
            `  ${tool.state}: ${tool.name} ${tool.range} (has ${tool.version ?? "none"})\n`,
          );
        }
      }
      if (driftReport) io.stdout(formatToolDriftReport(driftReport));
    }
    return res.drift || Boolean(driftReport?.hasDrift) ? 1 : 0;
  }

  if (action === "drift") {
    const json = rest.includes("--json");
    const reconcile = rest.includes("--reconcile");
    const force = rest.includes("--force");
    const repoIdx = rest.indexOf("--repo");
    const targetRepo = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;
    const srcIdx = rest.indexOf("--source");
    const refIdx = rest.indexOf("--ref");
    const marscodeRoot =
      (srcIdx >= 0 ? rest[srcIdx + 1] : undefined) || io.env.MARSCODE_ROOT?.trim() || undefined;
    const sourceRef =
      (refIdx >= 0 ? rest[refIdx + 1] : undefined) ||
      io.env.SHIP_QUEUE_SOURCE_REF?.trim() ||
      undefined;

    if (reconcile) {
      const rec = await reconcileToolDrift({
        queueRoot: root,
        manifestPath,
        marscodeRoot,
        sourceRef,
        targetRepo,
        force,
        freshProbe: true,
        onProgress: json ? undefined : (line) => io.stdout(`${line}\n`),
        deps: hostDeps,
      });
      if (!rec.ok && !rec.after) {
        io.stderr(`ship-queue hosts drift: ${rec.error ?? "failed"}\n`);
        return 2;
      }
      if (json) {
        io.stdout(`${JSON.stringify(rec, null, 2)}\n`);
      } else if (rec.after) {
        io.stdout(formatToolDriftReport(rec.after));
      }
      return rec.ok && !rec.after?.hasDrift ? 0 : 1;
    }

    const res = await checkHostsToolDrift({
      queueRoot: root,
      manifestPath,
      targetRepo,
      fresh: true,
      deps: hostDeps,
    });
    if (!res.ok || !res.report) {
      io.stderr(`ship-queue hosts drift: ${res.error ?? "failed"}\n`);
      return 2;
    }
    if (json) {
      io.stdout(`${JSON.stringify(res.report, null, 2)}\n`);
    } else {
      io.stdout(formatToolDriftReport(res.report));
    }
    return res.report.hasDrift ? 1 : 0;
  }

  if (action === "off" || action === "on") {
    const name = rest[0] ?? "";
    if (!name) {
      io.stderr(usage);
      return 64;
    }
    let reason = "";
    const reasonIdx = rest.indexOf("--reason");
    if (action === "off" && reasonIdx >= 0) {
      reason = rest[reasonIdx + 1] ?? "";
    }
    const res = setCiHostAvailability({
      queueRoot: root,
      hostName: name,
      enabled: action === "on",
      reason,
      manifestPath,
    });
    (res.ok ? io.stdout : io.stderr)(`${res.message}\n`);
    return res.ok ? 0 : 1;
  }

  if (action === "provision") {
    const hostName = rest[0] ?? "";
    if (!hostName) {
      io.stderr(usage);
      return 64;
    }
    const res = await provisionCiHost({
      queueRoot: root,
      hostName,
      manifestPath,
      marscodeRoot: io.env.MARSCODE_ROOT?.trim() || undefined,
      sourceRef: io.env.SHIP_QUEUE_SOURCE_REF?.trim() || undefined,
      onProgress: (line) => io.stdout(`${line}\n`),
    });
    (res.ok ? io.stdout : io.stderr)(`${res.message}\n`);
    return res.ok ? 0 : 1;
  }

  if (action === "sync") {
    const hostName = rest.find((a) => !a.startsWith("--")) ?? "";
    if (!hostName) {
      io.stderr(usage);
      return 64;
    }
    const srcIdx = rest.indexOf("--source");
    const refIdx = rest.indexOf("--ref");
    const reconcileTools = rest.includes("--reconcile-tools");
    const marscodeRoot =
      (srcIdx >= 0 ? rest[srcIdx + 1] : undefined) || io.env.MARSCODE_ROOT?.trim() || io.cwd;
    const sourceRef = (refIdx >= 0 ? rest[refIdx + 1] : undefined) || "HEAD";
    const loaded = loadCiHostsManifest({ overridePath: manifestPath });
    if (!loaded.ok || !loaded.manifest) {
      io.stderr(`ship-queue hosts sync: ${loaded.errors.join("; ")}\n`);
      return 1;
    }
    const host = loaded.manifest.hosts.find((h) => h.name === hostName);
    if (!host) {
      io.stderr(`ship-queue hosts sync: no CI host ${hostName}\n`);
      return 1;
    }
    const res = await syncCiHostPayload({ host, marscodeRoot, sourceRef, deps: hostDeps });
    if (!res.ok) {
      io.stderr(`ship-queue hosts sync: ${res.error ?? "failed"}\n`);
      return 1;
    }
    io.stdout(`synced ${host.name}: ${res.paths.join(", ")}\n`);
    if (reconcileTools) {
      const prov = await provisionCiHost({
        queueRoot: root,
        hostName: host.name,
        manifestPath,
        allowRoot: false,
        onProgress: (line) => io.stdout(`${line}\n`),
        deps: hostDeps,
      });
      if (!prov.ok) {
        io.stderr(`ship-queue hosts sync: ${prov.message}\n`);
        return 1;
      }
    }
    return 0;
  }

  io.stderr(`ship-queue hosts: unknown subcommand '${action}'\n${usage}`);
  return 64;
}

export async function runDepsSubcommand(
  root: string,
  args: ReadonlyArray<string>,
  io: SubcommandIo,
): Promise<number> {
  const [action, ...rest] = args;
  const usage =
    "ship-queue deps <status [--json] [REPO] | decide REPORT_ID approve|reject | scan REPO [--due] | rollback ATTEMPT_ID --reason TEXT>\n";

  if (!action || action === "--help" || action === "-h") {
    io.stdout(usage);
    return 0;
  }

  if (action === "status") {
    const json = rest.includes("--json");
    const repo = rest.find((a) => a !== "--json");
    const payload = listShipQueueDeps(root);
    const repos = repo ? payload.repos.filter((r) => r.repo === repo) : payload.repos;
    if (json) {
      io.stdout(`${JSON.stringify({ queueRoot: payload.queueRoot, repos }, null, 2)}\n`);
    } else {
      for (const r of repos) {
        io.stdout(
          `${r.repo}: status=${r.status} holding=${r.holding} pending=${r.pendingCount} report=${r.reportId ?? "none"}\n`,
        );
      }
    }
    return 0;
  }

  if (action === "decide") {
    const [reportId, decision] = rest;
    if (!reportId || (decision !== "approve" && decision !== "reject")) {
      io.stderr(usage);
      return 64;
    }
    const res = await decideShipQueueDeps(
      { queueRoot: root },
      { reportId, decision, cwd: io.cwd, threadId: io.env.T3CODE_THREAD_ID },
    );
    (res.ok ? io.stdout : io.stderr)(`${res.ok ? res.message : res.error}\n`);
    return res.ok ? 0 : 2;
  }

  if (action === "scan") {
    const repo = rest.find((a) => !a.startsWith("--")) ?? "";
    if (!repo) {
      io.stderr(usage);
      return 64;
    }
    const res = await scanShipQueueDepsRepo(
      { queueRoot: root },
      { repo, due: rest.includes("--due") },
    );
    if (!res.ok) {
      io.stderr(`ship-queue deps scan: ${res.error ?? "failed"}\n`);
      return 2;
    }
    io.stdout(`scan ${repo}: ${res.skipped ? "skipped" : "recorded"}\n`);
    return 0;
  }

  if (action === "rollback") {
    const attemptId = rest[0] ?? "";
    const reasonIdx = rest.indexOf("--reason");
    const reason = reasonIdx >= 0 ? (rest[reasonIdx + 1] ?? "") : "";
    if (!attemptId || !reason) {
      io.stderr(usage);
      return 64;
    }
    const res = await rollbackShipQueueDepsAttempt(
      { queueRoot: root },
      { attemptId, reason, cwd: io.cwd, threadId: io.env.T3CODE_THREAD_ID },
    );
    (res.ok ? io.stdout : io.stderr)(`${res.ok ? res.message : res.error}\n`);
    return res.ok ? 0 : 2;
  }

  io.stderr(`ship-queue deps: unknown subcommand '${action}'\n${usage}`);
  return 64;
}

export function runPinsSubcommand(args: ReadonlyArray<string>, io: SubcommandIo): number {
  const [action, ...rest] = args;
  const specIdx = rest.indexOf("--spec");
  const rootIdx = rest.indexOf("--root");
  const rootDir = (rootIdx >= 0 ? rest[rootIdx + 1] : undefined) || io.cwd;
  const specPath =
    (specIdx >= 0 ? rest[specIdx + 1] : undefined) ||
    NodePath.join(rootDir, "infra", "ci-host", "sq_pins.json");

  if (!action || action === "--help" || action === "-h") {
    io.stdout("ship-queue pins <extract|managers> [--spec PATH] [--root DIR]\n");
    return 0;
  }

  try {
    const spec = loadPinsSpec(specPath);
    if (action === "managers") {
      io.stdout(`${JSON.stringify(buildRenovateCustomManagers(spec), null, 2)}\n`);
      return 0;
    }
    if (action === "extract") {
      for (const row of extractPinVersions(spec, rootDir)) {
        io.stdout(`${row.name}\t${row.file}\t${row.depName}\t${row.currentValue}\n`);
      }
      return 0;
    }
    io.stderr(`ship-queue pins: unknown subcommand '${action}'\n`);
    return 64;
  } catch (err) {
    io.stderr(`ship-queue pins: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function runVersionSubcommand(
  root: string,
  args: ReadonlyArray<string>,
  io: SubcommandIo,
  deps: Pick<ShipQueueDeps, "clock" | "isProcessAlive" | "self">,
): number {
  const [rawAction, ...rest] = args;
  const action = rawAction ?? "current";
  const usage =
    "ship-queue version <current [--json] | stage VERSION --source-dir DIR [--entry REL_PATH] [--json] | prune [--json]>\n";

  if (action === "--help" || action === "-h") {
    io.stdout(usage);
    return 0;
  }

  const json = rest.includes("--json");

  if (action === "current") {
    const current = readCurrentWorkerVersion(root);
    if (json) {
      io.stdout(`${JSON.stringify({ queue_root: root, current }, null, 2)}\n`);
    } else if (current) {
      io.stdout(`${current.version} ${current.entryPath}\n`);
    } else {
      io.stdout("none\n");
    }
    return 0;
  }

  if (action === "stage") {
    const version = rest.find((a) => !a.startsWith("--")) ?? "";
    const srcIdx = rest.indexOf("--source-dir");
    const entryIdx = rest.indexOf("--entry");
    const sourceDir = srcIdx >= 0 ? (rest[srcIdx + 1] ?? "") : "";
    const entryRelPath = entryIdx >= 0 ? (rest[entryIdx + 1] ?? "") : "bin.mjs";
    if (!version || !sourceDir || !entryRelPath) {
      io.stderr(usage);
      return 64;
    }
    try {
      const staged = stageWorkerVersion({
        root,
        version,
        sourceDir: NodePath.resolve(io.cwd, sourceDir),
        entryRelPath,
        clock: deps.clock,
        self: deps.self,
        isAlive: deps.isProcessAlive,
      });
      if (json) {
        io.stdout(`${JSON.stringify(staged, null, 2)}\n`);
      } else {
        io.stdout(`staged version=${staged.version} entry=${staged.entryPath}\n`);
      }
      return 0;
    } catch (err) {
      io.stderr(`ship-queue version stage: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (action === "prune") {
    const res = pruneUnreferencedWorkerVersions({
      root,
      isAlive: deps.isProcessAlive,
      self: deps.self,
    });
    if (json) {
      io.stdout(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      io.stdout(
        `pruned=${res.pruned.length} kept=${res.kept.length}${res.skippedLocked ? " (skipped: locked)" : ""}\n`,
      );
    }
    return 0;
  }

  io.stderr(`ship-queue version: unknown subcommand '${action}'\n${usage}`);
  return 64;
}
