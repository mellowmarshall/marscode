// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { HostDiskVolume, HostGpuMetrics, HostHardwareDetails } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as HostResources from "./HostResources.ts";

class DiskStatError extends Schema.TaggedError<DiskStatError>()("DiskStatError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

const MIB = 1024 * 1024;
const VIRTUAL_MOUNT_TYPES = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fuse.gvfsd-fuse",
  "fuse.portal",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "ramfs",
  "rpc_pipefs",
  "securityfs",
  "selinuxfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);

function parseNullableNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("[") || trimmed.toUpperCase() === "N/A") {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function parseNonNegativeInt(raw: string | undefined, scale = 1): number | null {
  const value = parseNullableNumber(raw);
  if (value === null || value < 0) return null;
  return Math.max(0, Math.round(value * scale));
}

export function parseNvidiaSmiCsv(output: string): ReadonlyArray<HostGpuMetrics> {
  const gpus: Array<HostGpuMetrics> = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 6) continue;
    const index = parseNonNegativeInt(parts[0]);
    if (index === null) continue;
    const name = parts
      .slice(1, parts.length - 4)
      .join(",")
      .trim();
    if (!name) continue;
    const utilPercent = parseNullableNumber(parts[parts.length - 4]);
    const utilization = utilPercent === null ? null : Math.min(1, Math.max(0, utilPercent / 100));
    const memoryUsedBytes = parseNonNegativeInt(parts[parts.length - 3], MIB);
    const memoryTotalBytes = parseNonNegativeInt(parts[parts.length - 2], MIB);
    const temperatureC = parseNullableNumber(parts[parts.length - 1]);
    gpus.push({
      index,
      name,
      utilization,
      memoryUsedBytes,
      memoryTotalBytes,
      temperatureC,
    });
  }
  return gpus;
}

function parseLinuxDrmGpu(
  index: number,
  name: string | null,
  busyText: string,
  usedText: string,
  totalText: string,
  tempMilliText: string,
): HostGpuMetrics | null {
  const busyPercent = parseNullableNumber(busyText);
  const memoryUsedBytes = parseNonNegativeInt(usedText);
  const memoryTotalBytes = parseNonNegativeInt(totalText);
  if (busyPercent === null && memoryUsedBytes === null && memoryTotalBytes === null) {
    return null;
  }
  const tempMilli = parseNullableNumber(tempMilliText);
  const trimmedName = name?.trim() ?? "";
  return {
    index,
    name: trimmedName || `GPU ${index}`,
    utilization: busyPercent === null ? null : Math.min(1, Math.max(0, busyPercent / 100)),
    memoryUsedBytes,
    memoryTotalBytes,
    temperatureC: tempMilli === null ? null : Math.round((tempMilli / 1000) * 10) / 10,
  };
}

export interface DiskVolumeCandidate {
  readonly mount: string;
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly dev?: number | undefined;
}

export function deduplicateDiskVolumes(
  candidates: ReadonlyArray<DiskVolumeCandidate>,
): ReadonlyArray<HostDiskVolume> {
  const byFilesystem = new Map<string, HostDiskVolume>();
  for (const candidate of candidates) {
    const mount = candidate.mount.trim();
    if (!mount) continue;
    if (
      !Number.isFinite(candidate.totalBytes) ||
      !Number.isFinite(candidate.availableBytes) ||
      candidate.totalBytes <= 0
    ) {
      continue;
    }
    const totalBytes = Math.max(0, Math.round(candidate.totalBytes));
    const availableBytes = Math.min(totalBytes, Math.max(0, Math.round(candidate.availableBytes)));
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const key =
      candidate.dev !== undefined && candidate.dev > 0
        ? `dev:${candidate.dev}`
        : `cap:${totalBytes}:${availableBytes}`;
    const existing = byFilesystem.get(key);
    if (!existing || mount.length < existing.mount.length) {
      byFilesystem.set(key, { mount, totalBytes, availableBytes, usedBytes });
    }
  }
  return [...byFilesystem.values()];
}

function unescapeProcMountPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function resolveLinuxMountPoint(targetPath: string, procMounts: string): string {
  let bestMount: string | null = null;
  for (const rawLine of procMounts.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const fsType = parts[2] ?? "";
    if (VIRTUAL_MOUNT_TYPES.has(fsType)) continue;
    const mountPoint = unescapeProcMountPath(parts[1] ?? "");
    if (!mountPoint.startsWith("/")) continue;
    const matches =
      mountPoint === "/"
        ? targetPath.startsWith("/")
        : targetPath === mountPoint || targetPath.startsWith(`${mountPoint}/`);
    if (matches && (bestMount === null || mountPoint.length > bestMount.length)) {
      bestMount = mountPoint;
    }
  }
  return bestMount ?? targetPath;
}

export class HostHardware extends Context.Service<
  HostHardware,
  { readonly read: Effect.Effect<HostHardwareDetails> }
>()("t3/resourceTelemetry/HostHardware") {}

const make = Effect.fn("makeHostHardware")(function* () {
  const hostResources = yield* HostResources.HostResources;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig.ServerConfig;

  const readFile = (filePath: string) =>
    fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));

  const readDisks = Effect.fn("HostHardware.readDisks")(function* () {
    const rootPath = platform === "win32" ? path.parse(config.baseDir).root : "/";
    const rawTargets = [rootPath, NodeOS.homedir(), config.baseDir];
    const procMounts = platform === "linux" ? yield* readFile("/proc/mounts") : "";
    const resolvedTargets = rawTargets.map((target) =>
      procMounts ? resolveLinuxMountPoint(path.resolve(target), procMounts) : target,
    );
    const uniqueTargets = [...new Set(resolvedTargets)];
    const candidates = yield* Effect.forEach(
      uniqueTargets,
      Effect.fn("HostHardware.statVolume")(function* (mount) {
        const stats = yield* Effect.tryPromise({
          try: () => NodeFSP.statfs(mount),
          catch: (cause) => new DiskStatError({ path: mount, cause }),
        }).pipe(Effect.orElseSucceed(() => null));
        if (!stats || stats.blocks <= 0 || stats.bsize <= 0) return null;
        const dev = yield* fs.stat(mount).pipe(
          Effect.map((info) => Number(info.dev)),
          Effect.orElseSucceed(() => undefined),
        );
        return {
          mount,
          totalBytes: Number(stats.blocks) * Number(stats.bsize),
          availableBytes: Number(stats.bavail) * Number(stats.bsize),
          dev,
        };
      }),
      { concurrency: 4 },
    );
    return deduplicateDiskVolumes(candidates.filter((item) => item !== null));
  });

  const readLinuxDrmGpus = Effect.fn("HostHardware.readLinuxDrmGpus")(function* () {
    const entries = yield* fs.readDirectory("/sys/class/drm").pipe(Effect.orElseSucceed(() => []));
    const cards = entries
      .filter((entry) => /^card\d+$/.test(entry))
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
    const gpus = yield* Effect.forEach(
      cards,
      Effect.fn("HostHardware.readLinuxDrmCard")(function* (card) {
        const index = Number(card.slice(4));
        const deviceDir = `/sys/class/drm/${card}/device`;
        const [name, busy, used, total, hwmonEntries] = yield* Effect.all([
          readFile(`${deviceDir}/product_name`),
          readFile(`${deviceDir}/gpu_busy_percent`),
          readFile(`${deviceDir}/mem_info_vram_used`),
          readFile(`${deviceDir}/mem_info_vram_total`),
          fs.readDirectory(`${deviceDir}/hwmon`).pipe(Effect.orElseSucceed(() => [])),
        ]);
        const firstHwmon = hwmonEntries.find((entry) => /^hwmon\d+$/.test(entry));
        const tempMilli = firstHwmon
          ? yield* readFile(`${deviceDir}/hwmon/${firstHwmon}/temp1_input`)
          : "";
        return parseLinuxDrmGpu(index, name, busy, used, total, tempMilli);
      }),
      { concurrency: 4 },
    );
    return gpus.filter((gpu): gpu is HostGpuMetrics => gpu !== null);
  });

  const readGpus = Effect.fn("HostHardware.readGpus")(function* () {
    const nvidiaOutput = yield* spawner
      .string(
        ChildProcess.make(
          "nvidia-smi",
          [
            "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
          ],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.timeout("1 second"),
        Effect.orElseSucceed(() => ""),
      );
    const nvidiaGpus = parseNvidiaSmiCsv(nvidiaOutput);
    if (nvidiaGpus.length > 0) return nvidiaGpus;
    if (platform === "linux") return yield* readLinuxDrmGpus();
    return [];
  });

  const sample = Effect.fn("HostHardware.sample")(function* () {
    const [resources, disks, gpus] = yield* Effect.all(
      [hostResources.read, readDisks(), readGpus()],
      { concurrency: "unbounded" },
    );
    const rawUptime = NodeOS.uptime();
    const uptimeSeconds = Number.isFinite(rawUptime) ? Math.max(0, Math.floor(rawUptime)) : null;
    const avg = platform === "win32" ? null : NodeOS.loadavg();
    const loadAverage =
      avg && avg.length >= 3 && avg.every((n) => Number.isFinite(n))
        ? ([
            Math.round(avg[0]! * 100) / 100,
            Math.round(avg[1]! * 100) / 100,
            Math.round(avg[2]! * 100) / 100,
          ] as const)
        : null;
    return {
      ...resources,
      uptimeSeconds,
      loadAverage,
      disks,
      gpus,
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "hardware") => sample(),
    timeToLive: "5 seconds",
  });

  return HostHardware.of({ read: Cache.get(cache, "hardware") });
});

export const layer = Layer.effect(HostHardware, make());
