// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Picks the CI host for a job's install and CI steps through `routeCiJob`.
import * as NodeOS from "node:os";

import { expandDataRoot, loadCiHostsManifest, type CiHostEntry } from "./ciHosts.ts";
import {
  routeCiJob,
  type ActiveRouteLease,
  type FleetNodeTelemetrySample,
  type FleetTelemetryProvider,
} from "./ciRouter.ts";
import { serviceToolSpecs } from "./ciServicesPlan.ts";
import type { ShipDeclaration } from "./declaration.ts";
import { execOnHost, probeCiHost, type HostExecDeps } from "./hostProbe.ts";

export type CiPlacement =
  | {
      readonly kind: "local";
      readonly host: string;
      readonly dataRoot: string;
      readonly note: string;
    }
  | { readonly kind: "remote"; readonly host: CiHostEntry; readonly note: string }
  /** Hosts that fit exist but are off, on battery, or unsampled: the job waits and retries. */
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

export type CiPlacer = (input: {
  readonly jobId: string;
  readonly decl: ShipDeclaration;
  /** The services the job starts (the base's and the branch's): the host needs docker for them. */
  readonly services?: ReadonlyArray<string> | undefined;
  readonly activeLeases: ReadonlyArray<ActiveRouteLease>;
}) => Promise<CiPlacement>;

/** One load sample per host: "LOAD1 CORES BATTERY(0|1)", the legacy queue's fleet_load reading. */
const HOST_LOAD_SH = [
  'l=$(cut -d" " -f1 /proc/loadavg 2>/dev/null); c=$(nproc 2>/dev/null); b=0',
  'if [ -z "$l" ] && command -v sysctl >/dev/null 2>&1; then l=$(sysctl -n vm.loadavg 2>/dev/null | awk "{print \\$2}"); c=$(sysctl -n hw.ncpu 2>/dev/null); ! command -v pmset >/dev/null 2>&1 || ! pmset -g batt 2>/dev/null | grep -q "Battery Power" || b=1; fi',
  'echo "$l $c $b"',
].join("\n");

/**
 * Telemetry for a worker outside the MarsCode server: one SSH load sample per host, shaped like
 * `NativeFleetService` samples so `routeCiJob` reads both the same way.
 */
export async function sampleHostTelemetry(
  hosts: ReadonlyArray<CiHostEntry>,
  deps?: HostExecDeps,
): Promise<FleetTelemetryProvider> {
  const ts = new Date().toISOString();
  const nodes: Record<string, FleetNodeTelemetrySample> = {};
  await Promise.all(
    hosts.map(async (host) => {
      const res = await execOnHost(host, HOST_LOAD_SH, deps, { timeoutMs: 20_000 }).catch(
        () => null,
      );
      const [load, cores, battery] = (res?.exitCode === 0 ? res.stdout.trim() : "").split(/\s+/);
      const cpus = Number.parseInt(cores ?? "", 10);
      const load1 = Number.parseFloat(load ?? "");
      if (!Number.isInteger(cpus) || cpus < 1 || !Number.isFinite(load1)) return;
      const pct = Math.min(100, Math.max(0, (load1 / cpus) * 100));
      nodes[host.name] = {
        host: { name: host.name, cpus, cpu_pct: pct, cpu_hist: [pct], ts },
        power: battery === "1" ? "battery" : "ac",
      };
    }),
  );
  return { getNodesMap: () => nodes };
}

/**
 * The CLI worker's placer: `ci-hosts.json`, cached host probes, and fresh load samples, routed by
 * `routeCiJob`. With no manifest, CI runs on this host.
 */
export function manifestCiPlacer(options: {
  readonly queueRoot: string;
  readonly manifestPath?: string | undefined;
  readonly telemetry?: FleetTelemetryProvider | undefined;
  readonly deps?: HostExecDeps | undefined;
}): CiPlacer {
  return async ({ decl, services, activeLeases }) => {
    const loaded = loadCiHostsManifest({ overridePath: options.manifestPath });
    const fallbackRoot = process.env.SHIP_QUEUE_DATA_ROOT?.trim() ?? "";
    if (!loaded.ok || !loaded.manifest) {
      return {
        kind: "local",
        host: "local",
        dataRoot: fallbackRoot,
        note: `no usable ci-hosts.json (${loaded.errors[0] ?? "not found"}); CI runs on this host`,
      };
    }
    const manifest = loaded.manifest;
    const hosts = decl.ciLocalOnly ? manifest.hosts.filter((h) => h.ssh === null) : manifest.hosts;
    const probesByHost: Record<string, Readonly<Record<string, string>> | null> = {};
    await Promise.all(
      hosts.map(async (host) => {
        probesByHost[host.name] = await probeCiHost({
          queueRoot: options.queueRoot,
          manifest,
          manifestPath: loaded.path ?? undefined,
          host,
          deps: options.deps,
        }).catch(() => null);
      }),
    );
    const telemetry = options.telemetry ?? (await sampleHostTelemetry(hosts, options.deps));
    const routed = routeCiJob({
      queueRoot: options.queueRoot,
      manifest,
      telemetry,
      probesByHost,
      requiredTools: serviceToolSpecs(decl.ciTools, services ?? decl.ciServices),
      requiredArch: decl.ciArch,
      activeLeases,
      nowEpochSec: Math.floor(Date.now() / 1000),
      localOnly: decl.ciLocalOnly,
    });
    if (routed.kind === "unqualified") return { kind: "fail", reason: routed.reason };
    if (routed.kind !== "routed") return { kind: "wait", reason: routed.reason };
    const host = manifest.hosts.find((h) => h.name === routed.target.host);
    if (!host) return { kind: "fail", reason: `ci_host_unknown host=${routed.target.host}` };
    const note = `ci host ${host.name}: ${routed.target.verdict} (${routed.target.busy}/${routed.target.cores} cores busy)`;
    if (host.ssh === null) {
      return {
        kind: "local",
        host: host.name,
        dataRoot: expandDataRoot(host.data_root, options.deps?.homeDir ?? NodeOS.homedir()),
        note,
      };
    }
    return { kind: "remote", host, note };
  };
}
