/**
 * Canonical client-side resource state machine and typed error/service-health contracts for DevTools.
 * Replaces ambiguous boolean bags (`live`, `loading`, `unsupported`, `error`) with an explicit
 * discriminated `DevtoolsResourceStatus` across all streams and loaders.
 */

export const DEVTOOLS_ERROR_CODES = [
  "daemon_stopped",
  "tool_missing",
  "broker_offline",
  "guard_denied",
  "stale_state",
  "timeout",
  "cancelled",
  "invalid_input",
  "not_found",
  "forbidden",
  "rate_limited",
  "command_failed",
  "parse_error",
  "internal_error",
] as const;

export type DevtoolsErrorCode = (typeof DEVTOOLS_ERROR_CODES)[number];

const DEVTOOLS_ERROR_CODE_SET: ReadonlySet<string> = new Set(DEVTOOLS_ERROR_CODES);

export function parseDevtoolsErrorCode(raw: unknown): DevtoolsErrorCode | undefined {
  return typeof raw === "string" && DEVTOOLS_ERROR_CODE_SET.has(raw)
    ? (raw as DevtoolsErrorCode)
    : undefined;
}

export type DevtoolsServiceStatus = "uninstalled" | "stopped" | "reachable" | "error";

export interface DevtoolsServiceHealth {
  readonly devdeck: DevtoolsServiceStatus;
  readonly guardBroker: DevtoolsServiceStatus;
  readonly shipQueue: DevtoolsServiceStatus;
  readonly reaper: DevtoolsServiceStatus;
  readonly devlease: DevtoolsServiceStatus;
  readonly playbook: DevtoolsServiceStatus;
}

export type DevtoolsResourceStatus =
  | "unconfigured"
  | "connecting"
  | "offline"
  | "degraded"
  | "ready"
  | "error";

const OFFLINE_ERROR_RE =
  /\b(?:not running|not reachable|offline|disconnected|daemon.*stopped|broker.*not listening|econnrefused)\b/i;

const UNCONFIGURED_ERROR_RE = /\b(?:not installed|not supported on this host|not found in path)\b/i;

export function deriveStreamResourceStatus(input: {
  readonly unsupported: boolean;
  readonly live: boolean;
  readonly hasData: boolean;
  readonly error: string | null;
  readonly errorCode?: DevtoolsErrorCode | null | undefined;
}): DevtoolsResourceStatus {
  if (input.unsupported) return "unconfigured";
  if (input.errorCode === "tool_missing") return "unconfigured";
  if (input.error && UNCONFIGURED_ERROR_RE.test(input.error) && !input.hasData) {
    return "unconfigured";
  }
  if (input.live && !input.error && input.hasData) return "ready";
  if (input.error) {
    if (input.hasData) return "degraded";
    if (
      input.errorCode === "daemon_stopped" ||
      input.errorCode === "broker_offline" ||
      OFFLINE_ERROR_RE.test(input.error)
    ) {
      return "offline";
    }
    return "error";
  }
  if (input.hasData) return input.live ? "ready" : "degraded";
  return "connecting";
}

export function deriveFetchResourceStatus(input: {
  readonly loading: boolean;
  readonly hasData: boolean;
  readonly error: string | null;
  readonly errorCode?: DevtoolsErrorCode | null | undefined;
  readonly unconfigured?: boolean | undefined;
}): DevtoolsResourceStatus {
  if (input.unconfigured || input.errorCode === "tool_missing") return "unconfigured";
  if (input.error) {
    if (input.hasData) return "degraded";
    if (input.errorCode === "daemon_stopped" || input.errorCode === "broker_offline") {
      return "offline";
    }
    return "error";
  }
  if (input.hasData) return "ready";
  return input.loading ? "connecting" : "unconfigured";
}
