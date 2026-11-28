// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Standalone Node CLI log persistence for overrides.log and refusals.jsonl with injectable clock.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { GuardGrantReply } from "@t3tools/guard-protocol/client";
import { argvSha256 } from "@t3tools/guard-protocol/digests";

import { redactGuardCommand } from "./commandRedact.ts";
import { safeRealpath, type HostGuardsConfig } from "./hostConfig.ts";
import { defaultProcFs, type ProcFsReader } from "./procFs.ts";
import { resolveCallerIdentity } from "./procIdentity.ts";
import { resolveT3ThreadId } from "./t3ServerTrust.ts";

export const REFUSALS_FILE = "refusals.jsonl";
const REFUSALS_MAX_BYTES = 256 * 1024;

export interface OverrideLogRuntime {
  readonly config: HostGuardsConfig;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly procFs?: ProcFsReader | undefined;
  readonly now?: (() => Date) | undefined;
  readonly writeErr?: ((line: string) => void) | undefined;
  readonly allowEnvThreadId?: boolean | undefined;
  readonly testMode?: boolean | undefined;
}

function appendLine0600NoFollow(filePath: string, line: string): number {
  const flags =
    NodeFS.constants.O_CREAT |
    NodeFS.constants.O_APPEND |
    NodeFS.constants.O_WRONLY |
    (typeof NodeFS.constants.O_NOFOLLOW === "number" ? NodeFS.constants.O_NOFOLLOW : 0);
  const fd = NodeFS.openSync(filePath, flags, 0o600);
  try {
    NodeFS.writeSync(fd, line, undefined, "utf8");
    return NodeFS.fstatSync(fd).size;
  } finally {
    NodeFS.closeSync(fd);
  }
}

function withExclusiveLock<T>(lockPath: string, fn: () => T): T | undefined {
  let fd: number | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fd = NodeFS.openSync(
        lockPath,
        NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
        0o600,
      );
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        const st = NodeFS.statSync(lockPath);
        if (st.size === 0 && attempt >= 8) {
          NodeFS.unlinkSync(lockPath);
        }
      } catch {
        // Lock removed concurrently.
      }
    }
  }
  if (fd === null) return undefined;
  try {
    return fn();
  } finally {
    try {
      NodeFS.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      NodeFS.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function trimJsonl(filePath: string, keepBytes: number, fallbackLine: Buffer): void {
  try {
    const raw = NodeFS.readFileSync(filePath);
    if (raw.byteLength <= keepBytes) return;
    const tail = raw.subarray(raw.byteLength - keepBytes);
    const nl = tail.indexOf(0x0a);
    const trimmed = nl === -1 || nl === tail.byteLength - 1 ? fallbackLine : tail.subarray(nl + 1);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    const fd = NodeFS.openSync(
      tmpPath,
      NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
      0o600,
    );
    try {
      NodeFS.writeSync(fd, trimmed);
    } finally {
      NodeFS.closeSync(fd);
    }
    NodeFS.renameSync(tmpPath, filePath);
  } catch {
    // Best-effort log trim.
  }
}

function displayCommand(command: ReadonlyArray<string>): ReadonlyArray<string> {
  return command.length > 0 ? redactGuardCommand(command) : [];
}

export function writeOverrideRecord(
  input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly refusal: string;
    readonly why: string;
    readonly session: string;
    readonly via: string;
    readonly threadId?: string | undefined;
    readonly grantId?: string | undefined;
    readonly approvedVia?: string | undefined;
    readonly extra?: Readonly<Record<string, unknown>> | undefined;
  },
  runtime: OverrideLogRuntime,
): boolean {
  const nowFn = runtime.now ?? (() => new Date());
  const writeErr = runtime.writeErr ?? ((s: string) => process.stderr.write(`${s}\n`));
  const safeCmd = displayCommand(input.command);
  const firstLineRefusal = input.refusal.split(/\r?\n/, 1)[0] ?? "";
  const record: Record<string, unknown> = {
    at: nowFn().toISOString(),
    guard: input.guard,
    command: safeCmd,
    cwd: input.cwd,
    session: input.session,
    via: input.via,
    reason: input.why,
    refusal: firstLineRefusal,
  };
  if (input.threadId) record.thread_id = input.threadId;
  if (input.grantId) record.grant_id = input.grantId;
  if (input.approvedVia) record.approved_via = input.approvedVia;
  if (input.extra) {
    for (const [k, v] of Object.entries(input.extra)) {
      if (!(k in record)) record[k] = v;
    }
  }
  const stateDir = runtime.config.stateDir;
  const logPath = NodePath.join(stateDir, "overrides.log");
  try {
    NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    appendLine0600NoFollow(logPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    writeErr(
      `host-guard: cannot record the override (${err instanceof Error ? err.message : String(err)}); refusing`,
    );
    return false;
  }
  const bar = "!".repeat(72);
  writeErr(
    `${bar}\nhost-guard OVERRIDE (${input.guard}): ${input.why}\n` +
      `  via: ${input.via}\n` +
      `  would have refused: ${firstLineRefusal}\n` +
      `  recorded in ${logPath}\n${bar}`,
  );
  return true;
}

export function writeRefusalRecord(
  input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly refusal: string;
    readonly socketAvailable: boolean;
    readonly socketPath?: string | undefined;
    readonly deniedByOwner: boolean;
  },
  runtime: OverrideLogRuntime,
): void {
  const env = runtime.env ?? process.env;
  const procFs = runtime.procFs ?? defaultProcFs;
  const nowFn = runtime.now ?? (() => new Date());
  const identity = resolveCallerIdentity({
    env,
    testMode: runtime.testMode,
    procFs,
  });
  const threadId = resolveT3ThreadId(env, {
    procFs,
    socketPath: input.socketPath,
    allowEnvThreadId: runtime.allowEnvThreadId,
  });
  const safeCmd = redactGuardCommand(input.command).slice(0, 32);
  const redacted = input.guard === "argv" || safeCmd.some((tok, idx) => tok !== input.command[idx]);
  const entry: Record<string, unknown> = {
    at: nowFn().toISOString(),
    guard: input.guard,
    command: safeCmd,
    cwd: input.cwd ? safeRealpath(input.cwd) : "",
    session: identity.sessionId,
    thread_id: threadId,
    t3_terminal: identity.isT3Terminal,
    refusal: input.refusal.split(/\r?\n/, 1)[0] ?? "",
    t3_grant_available: input.socketAvailable,
  };
  if (!redacted) {
    entry.argv_sha256 = argvSha256(input.command);
  }
  if (input.deniedByOwner) {
    entry.denied_by_owner = true;
  }
  const stateDir = runtime.config.stateDir;
  const refusalsPath = NodePath.join(stateDir, REFUSALS_FILE);
  const lockPath = NodePath.join(stateDir, ".refusals.lock");
  const line = `${JSON.stringify(entry)}\n`;
  try {
    NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    withExclusiveLock(lockPath, () => {
      const size = appendLine0600NoFollow(refusalsPath, line);
      if (size > REFUSALS_MAX_BYTES) {
        trimJsonl(refusalsPath, Math.floor(REFUSALS_MAX_BYTES / 2), Buffer.from(line, "utf8"));
      }
    });
  } catch {
    // Refusal logging is best-effort.
  }
}

/** Records an override the broker granted (owner approval in MarsCode). */
export function recordBrokerGrant(
  reply: GuardGrantReply,
  input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly refusal: string;
    readonly proposedReason: string;
    readonly session: string;
    readonly threadId: string;
    readonly extra?: Readonly<Record<string, unknown>> | undefined;
  },
  runtime: OverrideLogRuntime,
): boolean {
  return writeOverrideRecord(
    {
      guard: input.guard,
      command: input.command,
      cwd: input.cwd,
      refusal: input.refusal,
      why: reply.reason || input.proposedReason || "Approved via MarsCode",
      session: input.session,
      via: "t3-input-request",
      threadId: reply.threadId || input.threadId,
      grantId: reply.grantId,
      approvedVia: reply.approvedVia,
      extra: input.extra,
    },
    runtime,
  );
}
