// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Host-local append-only audit of every Fleet CI on/off request.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { readLegacyAuditTail } from "../GuardAuditFiles.ts";

/** What the server did with one CI on/off request. */
export type CiToggleOutcome = "requested" | "applied" | "unchanged" | "refused" | "failed";

/** The `.off` record in force when the request arrived (null when CI was on). */
export interface CiToggleOffRecord {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
}

export interface CiToggleAuditEntry {
  readonly at: string;
  readonly host: string;
  readonly on: boolean;
  readonly outcome: CiToggleOutcome;
  /** The authenticated session subject that sent the request. */
  readonly actor: string;
  /** The client label the request carried (for example `fleet-console`). */
  readonly client: string;
  readonly confirmed: boolean;
  /** The reason of the `.off` marker a turn-on would remove (a console turn-off writes none). */
  readonly reason: string;
  readonly prior: CiToggleOffRecord | null;
  readonly message: string;
}

/** Who sent a CI toggle and whether the owner confirmed a turn-on that removes a reasoned marker. */
export interface CiToggleRequest {
  readonly confirm?: boolean | undefined;
  /** The `at` of the `.off` marker the confirmation dialog showed. */
  readonly confirmAt?: string | undefined;
  readonly actor?: string | undefined;
  readonly client?: string | undefined;
}

const LABEL_MAX = 80;

/** Bounds and flattens a client-supplied label so one audit line stays one line. */
export function cleanAuditLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const flat = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, LABEL_MAX);
  return flat || fallback;
}

/** The audit sits beside the `.off` markers it records, on the host that owns the queue. */
export function ciToggleAuditPath(queueRoot: string): string {
  return NodePath.join(queueRoot, "hosts", "ci-toggle-audit.jsonl");
}

/** Appends one JSON line. A write failure is returned, so the caller can report the gap. */
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

export function readCiToggleAudit(
  queueRoot: string,
  limit = 50,
): ReadonlyArray<Record<string, unknown>> {
  return readLegacyAuditTail(ciToggleAuditPath(queueRoot), limit);
}
