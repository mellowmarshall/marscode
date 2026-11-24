/**
 * Canonical DevTools error classification, host-guard banner stripping, and service health types.
 * Shared across `CliRunners.ts` and `DevtoolsHttp.ts` so every CLI and HTTP error arrives at the
 * client as a clean message paired with a machine-readable `DevtoolsErrorCode`.
 */

export type DevtoolsErrorCode =
  | "daemon_stopped"
  | "tool_missing"
  | "broker_offline"
  | "guard_denied"
  | "stale_state"
  | "timeout"
  | "cancelled"
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "command_failed"
  | "parse_error"
  | "internal_error";

export type DevtoolsServiceStatus = "uninstalled" | "stopped" | "reachable" | "error";

export interface DevtoolsServiceHealth {
  readonly devdeck: DevtoolsServiceStatus;
  readonly guardBroker: DevtoolsServiceStatus;
  readonly shipQueue: DevtoolsServiceStatus;
  readonly reaper: DevtoolsServiceStatus;
  readonly devlease: DevtoolsServiceStatus;
  readonly playbook: DevtoolsServiceStatus;
}

export interface NormalizedCliError {
  readonly code: DevtoolsErrorCode;
  readonly message: string;
}

const GUARD_BANNER_RE = /!{10,}\s*host-guard OVERRIDE[\s\S]*?(?:!{10,}|$)/g;
const WOULD_HAVE_REFUSED_RE = /would have refused:\s*([^\n!]+)/i;

/**
 * Removes noisy `!!!!! host-guard OVERRIDE (owner-check): ... !!!!!` audit banners from CLI output
 * while preserving the underlying command error (or the refusal summary if no trailing error exists).
 */
export function stripHostGuardBanner(raw: string): string {
  const stripped = raw.replace(GUARD_BANNER_RE, " ").replace(/\s+/g, " ").trim();
  if (stripped) return stripped;
  const refusedMatch = WOULD_HAVE_REFUSED_RE.exec(raw);
  if (refusedMatch?.[1]?.trim()) return refusedMatch[1].trim();
  return raw.trim();
}

export function classifyCliError(input: {
  readonly toolName: string;
  readonly exitCode: number;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
  readonly rawError?: string | undefined;
  readonly parseError?: string | undefined;
}): NormalizedCliError {
  const combinedRaw =
    input.rawError?.trim() ||
    input.stderr?.trim() ||
    input.parseError?.trim() ||
    input.stdout?.trim() ||
    "";
  const cleaned = combinedRaw ? stripHostGuardBanner(combinedRaw) : "";
  const message = cleaned || `${input.toolName} exited with code ${input.exitCode}`;
  // Classify ONLY on the stripped message so an approved override banner never misclassifies a
  // real downstream command failure as `guard_denied`.
  const lower = message.toLowerCase();
  const spawnLower = (input.rawError ?? "").toLowerCase();

  if (
    input.exitCode === 127 ||
    /\b(?:enoent|not found in path|is not installed)\b/.test(spawnLower)
  ) {
    return { code: "tool_missing", message };
  }
  if (input.exitCode === 124 || /\btimed out\b/.test(lower)) {
    return { code: "timeout", message };
  }
  if (input.exitCode === 130 || /\bcancelled\b/.test(lower)) {
    return { code: "cancelled", message };
  }
  if (
    /\b(?:differ from current main|scan again before deciding|report is stale|older than 24h)\b/.test(
      lower,
    )
  ) {
    return { code: "stale_state", message };
  }
  if (/\b(?:guard grant broker is not listening|broker.*not listening)\b/.test(lower)) {
    return { code: "broker_offline", message };
  }
  if (
    /\b(?:host-guard|owner-check|human-only action|override denied|override refused|would have refused)\b/.test(
      lower,
    )
  ) {
    return { code: "guard_denied", message };
  }
  if (
    /\b(?:econnrefused|connection refused|daemon is not running|daemon not reachable|not responding yet|service.*not active)\b/.test(
      lower,
    )
  ) {
    return { code: "daemon_stopped", message };
  }
  if (input.parseError || /\bnon-json output\b/.test(lower)) {
    return { code: "parse_error", message };
  }
  return { code: "command_failed", message };
}

export function inferHttpErrorCode(status: number, rawMessage: string): DevtoolsErrorCode {
  const lower = rawMessage.toLowerCase();
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 413 || status === 405) return "invalid_input";
  if (status === 504 || /\btimed out\b/.test(lower)) return "timeout";
  if (/\b(?:broker is not listening|broker.*offline)\b/.test(lower)) return "broker_offline";
  if (/\b(?:devdeck|daemon).*(?:not running|not reachable|unavailable|offline)\b/.test(lower)) {
    return "daemon_stopped";
  }
  if (/\b(?:not installed|not found in path)\b/.test(lower)) return "tool_missing";
  if (/\b(?:differ from current main|scan again|stale)\b/.test(lower)) return "stale_state";
  if (/\b(?:guard|refused|denied)\b/.test(lower)) return "guard_denied";
  if (status >= 500) return "internal_error";
  return "command_failed";
}

export function buildServiceHealth(input: {
  readonly devdeckInstalled: boolean;
  readonly devdeckReachable: boolean;
  readonly guardBrokerListening: boolean;
  readonly shipQueueInstalled: boolean;
  readonly reaperInstalled: boolean;
  readonly devleaseInstalled: boolean;
  readonly playbookInstalled: boolean;
}): DevtoolsServiceHealth {
  return {
    devdeck: !input.devdeckInstalled
      ? "uninstalled"
      : input.devdeckReachable
        ? "reachable"
        : "stopped",
    guardBroker: input.guardBrokerListening ? "reachable" : "stopped",
    shipQueue: input.shipQueueInstalled ? "reachable" : "uninstalled",
    reaper: input.reaperInstalled ? "reachable" : "uninstalled",
    devlease: input.devleaseInstalled ? "reachable" : "uninstalled",
    playbook: input.playbookInstalled ? "reachable" : "uninstalled",
  };
}
