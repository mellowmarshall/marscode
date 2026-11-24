import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  displayLimitWindows,
  elapsedShare,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
  planCapacity,
  remainingPercent,
} from "./usageLimits.ts";

const MINUTE_MS = 60_000;

/**
 * Matches desktop BrowserSession.ts `PREVIEW_EPHEMERAL_PARTITION_PREFIX` so embedded
 * OAuth webviews pass `will-attach-webview` while keeping auth cookies ephemeral.
 */
export const PREVIEW_EPHEMERAL_PARTITION_PREFIX = "t3code-preview-ephemeral-";

export function providerAuthWebviewPartition(flowId: string): string {
  const safeId = flowId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "session";
  return `${PREVIEW_EPHEMERAL_PARTITION_PREFIX}auth-${safeId}`;
}

export type LimitHealthLevel = "ok" | "warn" | "bad" | "off";

export interface WindowHealth {
  readonly level: LimitHealthLevel;
  readonly remainingPercent: number;
  readonly paceRemainingPercent: number | null;
  readonly burnoutMs: number | null;
}

export interface ClassifiedAccountWindows {
  readonly primary: ServerProviderUsageWindow | null;
  readonly secondary: readonly ServerProviderUsageWindow[];
}

export interface ClassifiedPoolWindows {
  readonly primary: LimitPoolWindow | null;
  readonly secondary: readonly LimitPoolWindow[];
}

export interface CombinedPoolBar {
  readonly remainingPercent: number;
  readonly level: LimitHealthLevel;
  readonly paceRemainingPercent: number | null;
  readonly burnoutMs: number | null;
  readonly dividerPositions: readonly number[];
  readonly earliestResetWindow: ServerProviderUsageWindow | null;
}

export interface LimitRecoveryTarget {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string;
  readonly reason: "unauthenticated" | "probeFailed";
  readonly message: string;
  readonly canAuthenticate: boolean;
}

export interface LimitRecoveryGroup {
  readonly driver: ServerProvider["driver"];
  readonly targets: readonly LimitRecoveryTarget[];
  readonly syncSource: {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly instanceId: ProviderInstanceId;
  } | null;
}

/**
 * Antigravity exposes third-party (Claude & GPT shared) quota buckets alongside Gemini.
 * Keep Antigravity limits strictly Gemini-only so unrelated quotas are never mixed or shared.
 */
export function isHiddenAntigravityThirdPartyWindow(
  driver: ServerProvider["driver"],
  window: Pick<ServerProviderUsageWindow, "id" | "label">,
): boolean {
  if (driver !== "antigravity") return false;
  const id = window.id.toLowerCase();
  if (id.startsWith("3p-") || id.startsWith("claude-") || id.startsWith("gpt-")) {
    return true;
  }
  return /\bclaude\s*[+&]\s*gpt\b/i.test(window.label);
}

export function shortWindowLabel(
  driver: ServerProvider["driver"],
  window: Pick<ServerProviderUsageWindow, "id" | "kind" | "label">,
): string {
  const raw = window.label.trim();
  if (window.kind === "session") {
    if (driver === "antigravity") {
      if (window.id.startsWith("gemini-argon-")) return "Argon 5h";
      if (window.id.startsWith("gemini-carbon-")) return "Carbon 5h";
    }
    if (/^(session|5-?hours?|gemini\s*·\s*5-?hours?)$/i.test(raw)) return "5-hour";
  }
  if (window.kind === "weekly") {
    if (/^(weekly|gemini\s*·\s*weekly)$/i.test(raw)) return "Weekly";
    const scoped = /^weekly\s*·\s*(.+)$/i.exec(raw);
    if (scoped?.[1]) return `${scoped[1].trim()} weekly`;
    if (driver === "antigravity") {
      if (window.id.startsWith("gemini-argon-")) return "Argon weekly";
      if (window.id.startsWith("gemini-carbon-")) return "Carbon weekly";
    }
  }
  return raw;
}

function isPrimaryWeeklyCandidate(
  driver: ServerProvider["driver"],
  window: Pick<ServerProviderUsageWindow, "id" | "kind" | "label">,
): boolean {
  if (window.kind !== "weekly") return false;
  if (driver === "claudeAgent") return window.id === "seven_day";
  if (driver === "antigravity") return window.id === "gemini-weekly";
  if (driver === "codex") return window.id === "secondary" || window.id === "weekly";
  return /^weekly$/i.test(window.label.trim());
}

function secondarySortRank(
  window: Pick<ServerProviderUsageWindow, "id" | "kind" | "label">,
): number {
  if (window.kind === "weekly") return 0;
  if (window.kind === "session") return 1;
  if (window.kind === "monthly") return 2;
  return 3;
}

function pickPrimaryIndex<T extends Pick<ServerProviderUsageWindow, "id" | "kind" | "label">>(
  driver: ServerProvider["driver"],
  windows: readonly T[],
): number {
  if (windows.length === 0) return -1;
  const exactWeekly = windows.findIndex((w) => isPrimaryWeeklyCandidate(driver, w));
  if (exactWeekly >= 0) return exactWeekly;
  const anyWeekly = windows.findIndex((w) => w.kind === "weekly");
  if (anyWeekly >= 0) return anyWeekly;
  const anyMonthly = windows.findIndex((w) => w.kind === "monthly");
  if (anyMonthly >= 0) return anyMonthly;
  return 0;
}

export function classifyAccountWindows(
  driver: ServerProvider["driver"],
  windows: readonly ServerProviderUsageWindow[],
): ClassifiedAccountWindows {
  const visible = windows.filter((w) => !isHiddenAntigravityThirdPartyWindow(driver, w));
  const primaryIndex = pickPrimaryIndex(driver, visible);
  if (primaryIndex < 0) return { primary: null, secondary: [] };
  const primary = visible[primaryIndex]!;
  const secondary = visible
    .filter((_, index) => index !== primaryIndex)
    .sort((a, b) => secondarySortRank(a) - secondarySortRank(b) || a.label.localeCompare(b.label));
  return { primary, secondary };
}

export function classifyPoolWindows(pool: LimitPool): ClassifiedPoolWindows {
  const visible = displayLimitWindows(pool).filter(
    (w) => !isHiddenAntigravityThirdPartyWindow(pool.driver, w),
  );
  const primaryIndex = pickPrimaryIndex(pool.driver, visible);
  if (primaryIndex < 0) return { primary: null, secondary: [] };
  const primary = visible[primaryIndex]!;
  const secondary = visible
    .filter((_, index) => index !== primaryIndex)
    .sort((a, b) => secondarySortRank(a) - secondarySortRank(b) || a.label.localeCompare(b.label));
  return { primary, secondary };
}

const HEALTH_RANK: Record<LimitHealthLevel, number> = { off: 0, ok: 1, warn: 2, bad: 3 };

function worseHealth(a: LimitHealthLevel, b: LimitHealthLevel): LimitHealthLevel {
  return HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b;
}

function evaluateHealth(
  usedPercent: number,
  elapsed: number | null,
  windowDurationMins: number | undefined,
  paceUsedPercent: number = usedPercent,
): WindowHealth {
  const clampedUsed = Math.max(0, Math.min(100, usedPercent));
  const clampedPaceUsed = Math.max(0, Math.min(100, paceUsedPercent));
  const rem = Math.round(100 - clampedUsed);
  const paceRem = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  if (rem <= 0) {
    return { level: "off", remainingPercent: 0, paceRemainingPercent: paceRem, burnoutMs: null };
  }
  const remLevel: LimitHealthLevel = rem <= 10 ? "bad" : rem <= 25 ? "warn" : "ok";
  let paceLevel: LimitHealthLevel = "ok";
  if (elapsed !== null) {
    const ahead = clampedPaceUsed - elapsed * 100;
    paceLevel = ahead > 25 ? "bad" : ahead > 5 ? "warn" : "ok";
  }
  const level = worseHealth(remLevel, paceLevel);
  let burnoutMs: number | null = null;
  if (
    elapsed !== null &&
    elapsed > 0 &&
    clampedPaceUsed > 0 &&
    windowDurationMins !== undefined &&
    windowDurationMins > 0 &&
    paceLevel !== "ok" &&
    clampedPaceUsed / elapsed >= 100
  ) {
    burnoutMs = Math.round(
      ((100 - clampedPaceUsed) / clampedPaceUsed) * elapsed * windowDurationMins * MINUTE_MS,
    );
  }
  return {
    level,
    remainingPercent: rem,
    paceRemainingPercent: paceRem,
    burnoutMs,
  };
}

export function windowHealth(window: ServerProviderUsageWindow, now: number): WindowHealth {
  return evaluateHealth(window.usedPercent, elapsedShare(window, now), window.windowDurationMins);
}

/**
 * Matches `poolMember` suppression in `usageLimits.ts`: only Claude's `seven_day` and
 * Codex's `weekly` caps suppress their 5-hour session window; other drivers report their
 * own live session percentages directly.
 */
export function isSessionBlockedByPrimary(
  driver: ServerProvider["driver"],
  primary: Pick<ServerProviderUsageWindow, "id" | "kind" | "usedPercent">,
  session: Pick<ServerProviderUsageWindow, "id" | "kind">,
): boolean {
  if (session.kind !== "session") return false;
  if (Math.round(100 - Math.max(0, Math.min(100, primary.usedPercent))) > 0) return false;
  if (driver === "claudeAgent") return primary.id === "seven_day";
  if (driver === "codex") return primary.kind === "weekly";
  return false;
}

export function buildCombinedPoolBar(poolWindow: LimitPoolWindow, now: number): CombinedPoolBar {
  const members = poolWindow.members;
  if (members.length === 0) {
    return {
      remainingPercent: 0,
      level: "off",
      paceRemainingPercent: null,
      burnoutMs: null,
      dividerPositions: [],
      earliestResetWindow: null,
    };
  }
  const capacities = members.map((m) => planCapacity(m.account, poolWindow.kind));
  const weights = capacities.every((c) => c !== undefined) ? capacities : members.map(() => 1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const weightedUsed =
    members.reduce((sum, m, index) => sum + m.window.usedPercent * weights[index]!, 0) /
    totalWeight;

  // Match poolWindows: judge pace only over timed members so untimed spent members never skew pace.
  const timed = members.flatMap((m, index) => {
    const share = elapsedShare(m.window, now);
    return share === null
      ? []
      : [
          {
            used: m.window.usedPercent,
            share,
            weight: weights[index]!,
            durationMins: m.window.windowDurationMins,
          },
        ];
  });
  const timedWeight = timed.reduce((sum, t) => sum + t.weight, 0);
  const meanElapsed =
    timed.length > 0 ? timed.reduce((sum, t) => sum + t.share * t.weight, 0) / timedWeight : null;
  const timedUsed =
    timed.length > 0
      ? timed.reduce((sum, t) => sum + t.used * t.weight, 0) / timedWeight
      : weightedUsed;
  const durationMins = timed.find((t) => t.durationMins !== undefined)?.durationMins;

  const health = evaluateHealth(weightedUsed, meanElapsed, durationMins, timedUsed);

  const dividerPositions: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < members.length - 1; i++) {
    const memberRem = remainingPercent(members[i]!.window);
    const sharePct = (memberRem * weights[i]!) / totalWeight;
    cumulative += sharePct;
    const rounded = Number(cumulative.toFixed(1));
    const previous = dividerPositions[dividerPositions.length - 1];
    if (
      rounded > 0.5 &&
      rounded < health.remainingPercent - 0.5 &&
      (previous === undefined || rounded - previous >= 0.5)
    ) {
      dividerPositions.push(rounded);
    }
  }

  const earliestResetWindow = poolWindow.resets[0]?.member.window ?? null;

  return {
    remainingPercent: health.remainingPercent,
    level: health.level,
    paceRemainingPercent: health.paceRemainingPercent,
    burnoutMs: health.burnoutMs,
    dividerPositions,
    earliestResetWindow,
  };
}

function isAuthFailureMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /not authenticated|not signed in|sign in|authenticate|codex login|claude login|oauth|unauthorized|401/i.test(
    message,
  );
}

/**
 * Collects actionable provider auth/probe recovery groups keyed by driver so the UI can
 * offer in-app session sync or sign-in directly on the affected provider card.
 */
export function collectLimitRecoveries(
  presentations: LimitPresentations,
): readonly LimitRecoveryGroup[] {
  const byDriver = new Map<ServerProvider["driver"], LimitRecoveryTarget[]>();
  const healthySourceByDriver = new Map<
    ServerProvider["driver"],
    {
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
      readonly instanceId: ProviderInstanceId;
    }
  >();

  for (const [environmentId, presentation] of presentations) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!provider.enabled || !provider.installed) continue;
      if (provider.auth.status === "authenticated" && provider.status === "ready") {
        if (!healthySourceByDriver.has(provider.driver)) {
          healthySourceByDriver.set(provider.driver, {
            environmentId,
            environmentLabel,
            instanceId: provider.instanceId,
          });
        }
        continue;
      }

      const unavailable = provider.usageLimits?.unavailable;
      const isUnauthenticated =
        provider.auth.status === "unauthenticated" ||
        (unavailable?.reason === "probeFailed" && isAuthFailureMessage(unavailable.message));
      const isProbeFailed = unavailable?.reason === "probeFailed";

      if (!isUnauthenticated && !isProbeFailed) continue;
      if (unavailable?.reason === "unsupported") continue;

      // Only surface unauthenticated providers that report limits or support authentication.
      if (!isProbeFailed && provider.usageLimits === undefined && provider.status !== "error") {
        continue;
      }

      const message =
        unavailable?.message ??
        provider.message ??
        (isUnauthenticated ? "Sign in required to read usage limits." : "Could not read limits.");
      const target: LimitRecoveryTarget = {
        environmentId,
        environmentLabel,
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || String(provider.driver),
        reason: isUnauthenticated ? "unauthenticated" : "probeFailed",
        message,
        canAuthenticate: provider.setup?.canAuthenticate !== false,
      };
      const list = byDriver.get(provider.driver);
      if (list) list.push(target);
      else byDriver.set(provider.driver, [target]);
    }
  }

  return [...byDriver].map(([driver, targets]) => ({
    driver,
    targets,
    syncSource: healthySourceByDriver.get(driver) ?? null,
  }));
}
