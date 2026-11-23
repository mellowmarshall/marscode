import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as HostHardware from "./HostHardware.ts";
import * as HostResources from "./HostResources.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const fakeResources = {
  sampledAt: 1_700_000_000_000,
  cpuUtilization: 0.35,
  cpuCount: 16,
  availableMemoryBytes: 20 * GIB,
  totalMemoryBytes: 64 * GIB,
};

function makeTestLayer(options: {
  readonly files?: Record<string, string | ReadonlyArray<string>>;
  readonly nvidiaSmiOutput?: string | null;
  readonly onSpawn?: () => void;
}) {
  const files = options.files ?? {};
  const nvidiaSmiOutput = options.nvidiaSmiOutput ?? null;

  const fsLayer = FileSystem.layerNoop({
    readFileString: (filePath) => {
      const value = files[filePath];
      if (typeof value !== "string") {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: filePath,
          }),
        );
      }
      return Effect.succeed(value);
    },
    readDirectory: (dirPath) => {
      const value = files[dirPath];
      if (!Array.isArray(value)) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readDirectory",
            pathOrDescriptor: dirPath,
          }),
        );
      }
      return Effect.succeed([...value]);
    },
    stat: () =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "stat",
          pathOrDescriptor: "",
        }),
      ),
  });

  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => {
      options.onSpawn?.();
      if (nvidiaSmiOutput === null) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcessSpawner",
            method: "spawn",
            pathOrDescriptor: "nvidia-smi",
          }),
        );
      }
      const bytes = new TextEncoder().encode(nvidiaSmiOutput);
      return Effect.succeed({
        pid: 1234,
        exitCode: Effect.succeed(0),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: {} as never,
        stdout: Stream.make(bytes),
        stderr: Stream.empty,
        all: Stream.make(bytes),
      } as never);
    }),
  );

  return HostHardware.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fsLayer,
        Path.layer,
        spawnerLayer,
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(
          HostResources.HostResources,
          HostResources.HostResources.of({ read: Effect.succeed(fakeResources) }),
        ),
        ServerConfig.layerTest(NodeOS.tmpdir(), { prefix: "t3-host-hardware-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}

describe("HostHardware", () => {
  it("parses nvidia-smi CSV output including multi-GPU and N/A fields", () => {
    const parsed = HostHardware.parseNvidiaSmiCsv(
      [
        "0, NVIDIA GeForce RTX 4090, 62, 14336, 24564, 71",
        "1, Virtual, Display [N/A], [N/A], [N/A], 16384, [Not Supported]",
        "",
      ].join("\n"),
    );

    assert.strictEqual(parsed.length, 2);
    assert.deepStrictEqual(parsed[0], {
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      utilization: 0.62,
      memoryUsedBytes: 14336 * MIB,
      memoryTotalBytes: 24564 * MIB,
      temperatureC: 71,
    });
    assert.deepStrictEqual(parsed[1], {
      index: 1,
      name: "Virtual, Display [N/A]",
      utilization: null,
      memoryUsedBytes: null,
      memoryTotalBytes: 16384 * MIB,
      temperatureC: null,
    });

    assert.deepStrictEqual(HostHardware.parseNvidiaSmiCsv("not valid output\n"), []);
  });

  it("deduplicates disk volumes by filesystem device and keeps the shorter mount path", () => {
    const volumes = HostHardware.deduplicateDiskVolumes([
      { mount: "/home/user", totalBytes: 500 * GIB, availableBytes: 200 * GIB, dev: 10 },
      { mount: "/", totalBytes: 500 * GIB, availableBytes: 200 * GIB, dev: 10 },
      { mount: "/data", totalBytes: 2000 * GIB, availableBytes: 800 * GIB, dev: 20 },
      { mount: "/invalid", totalBytes: 0, availableBytes: 0, dev: 30 },
    ]);

    assert.deepStrictEqual(volumes, [
      {
        mount: "/",
        totalBytes: 500 * GIB,
        availableBytes: 200 * GIB,
        usedBytes: 300 * GIB,
      },
      {
        mount: "/data",
        totalBytes: 2000 * GIB,
        availableBytes: 800 * GIB,
        usedBytes: 1200 * GIB,
      },
    ]);
  });

  it("resolves canonical Linux mount points while ignoring virtual filesystems", () => {
    const procMounts = [
      "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
      "tmpfs /tmp tmpfs rw,nosuid,nodev 0 0",
      "/dev/nvme1n1p1 /data ext4 rw,relatime 0 0",
    ].join("\n");

    assert.strictEqual(
      HostHardware.resolveLinuxMountPoint("/data/Dev/t3code", procMounts),
      "/data",
    );
    assert.strictEqual(HostHardware.resolveLinuxMountPoint("/tmp/t3-test", procMounts), "/");
    assert.strictEqual(HostHardware.resolveLinuxMountPoint("/home/dev", procMounts), "/");
  });

  it.effect("falls back to Linux AMD DRM sysfs when nvidia-smi is unavailable", () =>
    Effect.gen(function* () {
      const hardware = yield* HostHardware.HostHardware;
      const details = yield* hardware.read;

      assert.strictEqual(details.cpuCount, 16);
      assert.strictEqual(details.gpus.length, 1);
      assert.deepStrictEqual(details.gpus[0], {
        index: 0,
        name: "AMD Radeon RX 7900 XTX",
        utilization: 0.48,
        memoryUsedBytes: 4 * GIB,
        memoryTotalBytes: 24 * GIB,
        temperatureC: 58.5,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer({
          files: {
            "/sys/class/drm": ["renderD128", "card0", "card0-DP-1"],
            "/sys/class/drm/card0/device/product_name": "AMD Radeon RX 7900 XTX\n",
            "/sys/class/drm/card0/device/gpu_busy_percent": "48\n",
            "/sys/class/drm/card0/device/mem_info_vram_used": `${4 * GIB}\n`,
            "/sys/class/drm/card0/device/mem_info_vram_total": `${24 * GIB}\n`,
            "/sys/class/drm/card0/device/hwmon": ["hwmon2"],
            "/sys/class/drm/card0/device/hwmon/hwmon2/temp1_input": "58500\n",
          },
          nvidiaSmiOutput: null,
        }),
      ),
    ),
  );

  it.effect("returns empty GPUs on CPU-only hosts and caches hardware reads for 5 seconds", () => {
    let spawns = 0;
    return Effect.gen(function* () {
      const hardware = yield* HostHardware.HostHardware;
      const first = yield* hardware.read;
      const second = yield* hardware.read;
      yield* TestClock.adjust("5 seconds");
      const third = yield* hardware.read;

      assert.deepStrictEqual(first.gpus, []);
      assert.strictEqual(second.gpus.length, 0);
      assert.strictEqual(third.gpus.length, 0);
      assert.strictEqual(spawns, 2);
    }).pipe(
      Effect.provide(
        makeTestLayer({
          onSpawn: () => {
            spawns += 1;
          },
        }),
      ),
    );
  });
});
