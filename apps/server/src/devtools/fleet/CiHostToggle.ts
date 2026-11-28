// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The Fleet CI on/off policy: confirm a turn-on that removes a reasoned `.off` marker, and audit every request.
import { isSafeHostName } from "@t3tools/ship-queue/ciHosts";
import {
  readHostOffState,
  setCiHostAvailability,
  type HostOffState,
} from "@t3tools/ship-queue/hostOffMarker";
import {
  appendCiToggleAudit,
  type CiToggleOffRecord,
  type CiToggleOutcome,
} from "@t3tools/ship-queue/ciToggleAudit";

import { cleanAuditLabel, type CiToggleRequest } from "./CiToggleAudit.ts";

export interface CiHostToggleResult {
  readonly ok: boolean;
  readonly message: string;
  /** True when the refusal is because the turn-on needs (a fresh) confirmation. */
  readonly needsConfirm?: boolean;
}

const UNREADABLE = "unreadable .off marker";

/** The one read of the marker a request acts on. */
function liveOffState(queueRoot: string, host: string): HostOffState | null {
  try {
    return readHostOffState(queueRoot, host);
  } catch {
    // The marker exists but cannot be read: it is off, nobody can see why, and nothing matches it.
    return { at: "", by: "", reason: UNREADABLE, version: "" };
  }
}

function audit(
  queueRoot: string,
  host: string,
  on: boolean,
  outcome: CiToggleOutcome,
  request: CiToggleRequest,
  reason: string,
  prior: CiToggleOffRecord | null,
  message: string,
): boolean {
  return appendCiToggleAudit(queueRoot, {
    at: new Date().toISOString(),
    host: cleanAuditLabel(host, "?"),
    on,
    outcome,
    actor: cleanAuditLabel(request.actor, "unknown"),
    client: cleanAuditLabel(request.client, "unknown"),
    confirmed: request.confirm === true,
    reason,
    prior,
    message,
  }).ok;
}

/**
 * A turn-on that would remove an `.off` marker carrying a reason (usually the owner protecting a
 * long task) needs `confirm: true` together with the `version` of the marker the dialog showed, so
 * a confirmation only ever applies to that exact marker. Pure: judges the one read it is given.
 */
function confirmationRefusal(
  name: string,
  prior: HostOffState | null,
  request: CiToggleRequest,
): CiHostToggleResult | null {
  const reason = prior?.reason.trim() ?? "";
  if (!prior || !reason) return null;
  if (reason === UNREADABLE) {
    return {
      ok: false,
      message: `CI stays off on ${name}: its .off marker cannot be read. Inspect it with \`ship-queue hosts\` first.`,
    };
  }
  const who = `${prior.by || "unknown"} at ${prior.at || "an unknown time"} (${reason})`;
  if (request.confirm !== true) {
    return {
      ok: false,
      needsConfirm: true,
      message: `CI stays off on ${name}: it was turned off by ${who}. Turning it on needs an explicit confirmation.`,
    };
  }
  if (request.confirmVersion !== prior.version) {
    return {
      ok: false,
      needsConfirm: true,
      message: `CI stays off on ${name}: its .off marker changed since the confirmation was shown (now by ${who}). Confirm again.`,
    };
  }
  return null;
}

/** The route's early answer (409/423) before an action starts; audited. Null to proceed. */
export function refuseUnconfirmedTurnOn(
  queueRoot: string,
  host: string,
  enabled: boolean,
  request: CiToggleRequest,
): CiHostToggleResult | null {
  const name = host.trim();
  if (!enabled || !isSafeHostName(name)) return null;
  const prior = liveOffState(queueRoot, name);
  const refusal = confirmationRefusal(name, prior, request);
  if (refusal)
    audit(queueRoot, name, true, "refused", request, prior?.reason ?? "", prior, refusal.message);
  return refusal;
}

/** Applies one Fleet CI toggle under the confirmation policy, and audits it whatever the outcome. */
export function toggleCiHost(input: {
  readonly queueRoot: string;
  readonly manifestPath: string | undefined;
  readonly host: string;
  readonly enabled: boolean;
  readonly request: CiToggleRequest;
  readonly knownHosts: ReadonlySet<string>;
}): CiHostToggleResult {
  const { queueRoot, enabled, request } = input;
  const name = input.host.trim();
  const refuse = (message: string): CiHostToggleResult => {
    audit(queueRoot, name, enabled, "refused", request, "", null, message);
    return { ok: false, message };
  };
  if (!isSafeHostName(name)) return refuse(`Invalid host name: ${name}`);
  if (input.knownHosts.size > 0 && !input.knownHosts.has(name)) {
    return refuse(`${name} is not a known CI host`);
  }
  // One read: the confirmation is judged against it, and only this exact marker is removed.
  const prior = enabled ? liveOffState(queueRoot, name) : null;
  const priorReason = prior?.reason.trim() ?? "";
  const refusal = confirmationRefusal(name, prior, request);
  if (refusal) {
    audit(queueRoot, name, true, "refused", request, priorReason, prior, refusal.message);
    return refusal;
  }
  if (enabled && !prior) {
    // Nothing was seen, so nothing is removed, even a marker written after this read.
    const message = `ci host ${name} is already on for CI`;
    audit(queueRoot, name, true, "unchanged", request, "", null, message);
    return { ok: true, message };
  }
  // A turn-on is the dangerous direction: it is recorded before it happens, or it does not happen.
  if (enabled && prior) {
    const pre = `turning CI on for ${name}`;
    if (!audit(queueRoot, name, true, "requested", request, priorReason, prior, pre)) {
      return {
        ok: false,
        message: `CI stays off on ${name}: the CI toggle audit cannot be written`,
      };
    }
  }
  const actor = cleanAuditLabel(request.actor, "");
  let res: { readonly ok: boolean; readonly message: string; readonly changed: boolean };
  try {
    res = setCiHostAvailability({
      queueRoot,
      hostName: name,
      enabled,
      // The console asks for no reason, so its own marker carries none; a reason is the owner's.
      reason: "",
      actor: actor ? `t3code (${actor})` : "t3code",
      manifestPath: input.manifestPath,
      expectVersion: prior?.version,
    });
  } catch (error) {
    res = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      changed: false,
    };
  }
  const outcome: CiToggleOutcome = !res.ok ? "failed" : res.changed ? "applied" : "unchanged";
  const audited = audit(
    queueRoot,
    name,
    enabled,
    outcome,
    request,
    priorReason,
    prior,
    res.message,
  );
  if (!res.ok) return { ok: false, message: res.message };
  return {
    ok: true,
    message: audited ? res.message : `${res.message} (the CI toggle audit could not be written)`,
  };
}
