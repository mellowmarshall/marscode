// @effect-diagnostics nodeBuiltinImport:off - Host-local append-only audit of every CI host on/off request (Fleet console and `ship-queue hosts`).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** What happened to one CI on/off request. */
export type CiToggleOutcome = "requested" | "applied" | "unchanged" | "refused" | "failed";

/** The `.off` record in force when the request arrived (null when CI was on). */
export interface CiToggleOffRecord {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
  /** Content hash of the marker bytes, when it was readable. */
  readonly version?: string;
}

export interface CiToggleAuditEntry {
  readonly at: string;
  readonly host: string;
  readonly on: boolean;
  readonly outcome: CiToggleOutcome;
  /** Who asked: the server session subject, or the OS user for the CLI. */
  readonly actor: string;
  /** Where the request came from (`fleet-console`, `ship-queue-cli`, ...). */
  readonly client: string;
  /** True when the owner confirmed (Fleet dialog) or approved (host-guard override) a turn-on. */
  readonly confirmed: boolean;
  /** The reason of the `.off` marker a turn-on would remove, or the reason a turn-off wrote. */
  readonly reason: string;
  readonly prior: CiToggleOffRecord | null;
  readonly message: string;
}

/** The audit sits beside the `.off` markers it records, on the host that owns the queue. */
export function ciToggleAuditPath(queueRoot: string): string {
  return NodePath.join(queueRoot, "hosts", "ci-toggle-audit.jsonl");
}

/** Appends one JSON line. A write failure is returned, so the caller can refuse or report the gap. */
export function appendCiToggleAudit(
  queueRoot: string,
  entry: CiToggleAuditEntry,
): { readonly ok: boolean; readonly error?: string } {
  const filePath = ciToggleAuditPath(queueRoot);
  try {
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });
    NodeFS.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
