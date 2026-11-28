// @effect-diagnostics nodeBuiltinImport:off - Runs the real host `ps` scan through NativeFleetService.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { NativeFleetService } from "./NativeFleetService.ts";
import type { ParsedPsProcess } from "./NativeSessionsScanner.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("NativeFleetService process table", () => {
  it.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "forwards each fresh sessions-scan process table, including this process",
    async () => {
      const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fleet-ptable-"));
      tempDirs.push(stateDir);
      const tables: Array<ReadonlyArray<ParsedPsProcess>> = [];
      const fleet = new NativeFleetService({
        hostname: "host-a",
        stateDir,
        platform: "linux",
        enableBackgroundPolling: false,
        onProcessTable: (rows) => tables.push(rows),
      });
      try {
        await fleet.getServers();
        expect(tables).toHaveLength(1);
        const self = tables[0]!.find((p) => p.pid === process.pid);
        expect(self?.ppid).toBe(process.ppid);
        expect(self?.memBytes).toBeGreaterThan(0);
        // Inside the on-demand scan TTL no new scan runs, so nothing is forwarded again.
        await fleet.getServers();
        expect(tables).toHaveLength(1);
      } finally {
        fleet.close();
      }
    },
  );
});
