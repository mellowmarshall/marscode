// @effect-diagnostics nodeBuiltinImport:off - The Fleet console's side of the CI toggle audit: request shape, label cleaning, and reads.
import { ciToggleAuditPath } from "@t3tools/ship-queue/ciToggleAudit";

import { readLegacyAuditTail } from "../GuardAuditFiles.ts";

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

export function readCiToggleAudit(
  queueRoot: string,
  limit = 50,
): ReadonlyArray<Record<string, unknown>> {
  return readLegacyAuditTail(ciToggleAuditPath(queueRoot), limit);
}
