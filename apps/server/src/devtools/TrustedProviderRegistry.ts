// @effect-diagnostics nodeBuiltinImport:off - Tracks live Codex app-server (pid, starttime) pairs from /proc for GuardGrantBroker peer verification.
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface TrustedCodexAppServer {
  readonly pid: number;
  readonly startTime: string;
}

export interface TrustedProviderRegistryShape {
  readonly registerCodexAppServer: (pid: number) => () => void;
  readonly snapshotCodexAppServers: () => ReadonlyArray<TrustedCodexAppServer>;
}

const PROC_STARTTIME_RE = /^\d+$/;

export function readProcStartTime(pid: number, procRoot = "/proc"): string | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    const raw = NodeFS.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const rparen = raw.lastIndexOf(")");
    if (rparen === -1) return undefined;
    // After comm: state=0, ppid=1, ..., starttime=19 (field 22 overall).
    const fields = raw
      .slice(rparen + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    return startTime !== undefined && PROC_STARTTIME_RE.test(startTime) ? startTime : undefined;
  } catch {
    return undefined;
  }
}

export function makeTrustedProviderRegistry(
  readStartTime: (pid: number) => string | undefined = readProcStartTime,
): TrustedProviderRegistryShape {
  const entries = new Map<number, string>();
  return {
    registerCodexAppServer: (pid: number) => {
      const startTime = readStartTime(pid);
      if (startTime === undefined) return () => {};
      entries.set(pid, startTime);
      return () => {
        if (entries.get(pid) === startTime) {
          entries.delete(pid);
        }
      };
    },
    snapshotCodexAppServers: () =>
      Array.from(entries.entries(), ([pid, startTime]) => ({ pid, startTime })),
  };
}

export const TrustedProviderRegistry = Context.Reference<TrustedProviderRegistryShape>(
  "t3/devtools/TrustedProviderRegistry",
  {
    defaultValue: () => ({
      registerCodexAppServer: () => () => {},
      snapshotCodexAppServers: () => [],
    }),
  },
);

export const layer = Layer.effect(
  TrustedProviderRegistry,
  Effect.sync(() => makeTrustedProviderRegistry()),
);
