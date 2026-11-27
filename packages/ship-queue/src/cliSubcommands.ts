// @effect-diagnostics nodeBuiltinImport:off - Headless CLI subcommands for `ship-queue hosts`, `ship-queue deps`, and `ship-queue pins`.
import * as NodePath from "node:path";

import { loadCiHostsManifest } from "./ciHosts.ts";
import { decideShipQueueDeps, listShipQueueDeps } from "./depsEngine.ts";
import { rollbackShipQueueDepsAttempt } from "./depsRollback.ts";
import { scanShipQueueDepsRepo } from "./depsScan.ts";
import { checkCiHosts, setCiHostAvailability } from "./hostProbe.ts";
import { provisionCiHost, syncCiHostPayload } from "./hostProvision.ts";
import { buildRenovateCustomManagers, extractPinVersions, loadPinsSpec } from "./pins.ts";

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
): Promise<number> {
  const [action, ...rest] = args;
  const manifestPath = io.env.SHIP_QUEUE_CI_HOSTS?.trim() || undefined;
  const usage =
    "ship-queue hosts <check [--json] [HOST] | off NAME [--reason TEXT] | on NAME | provision HOST | sync HOST [--source DIR] [--ref REF]>\n";

  if (!action || action === "--help" || action === "-h") {
    io.stdout(usage);
    return 0;
  }

  if (action === "check") {
    const json = rest.includes("--json");
    const targetHost = rest.find((a) => a !== "--json");
    const res = await checkCiHosts({ queueRoot: root, manifestPath, targetHost });
    if (!res.ok || !res.report) {
      io.stderr(`ship-queue hosts check: ${res.error ?? "failed"}\n`);
      return 2;
    }
    if (json) {
      io.stdout(`${JSON.stringify(res.report, null, 2)}\n`);
    } else {
      for (const h of res.report.hosts) {
        io.stdout(
          `${h.name} (${h.ssh ?? "this host"}): ${h.reached ? "reached" : "UNREACHABLE"}${h.ci_off ? " [OFF]" : ""}\n`,
        );
      }
    }
    return res.drift ? 1 : 0;
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
    const hostName = rest[0] ?? "";
    if (!hostName) {
      io.stderr(usage);
      return 64;
    }
    const srcIdx = rest.indexOf("--source");
    const refIdx = rest.indexOf("--ref");
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
    const res = await syncCiHostPayload({ host, marscodeRoot, sourceRef });
    if (!res.ok) {
      io.stderr(`ship-queue hosts sync: ${res.error ?? "failed"}\n`);
      return 1;
    }
    io.stdout(`synced ${host.name}: ${res.paths.join(", ")}\n`);
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
