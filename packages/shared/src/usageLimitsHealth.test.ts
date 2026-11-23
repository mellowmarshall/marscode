import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitAccounts, collectLimitPools } from "./usageLimits.ts";
import {
  buildCombinedPoolBar,
  classifyAccountWindows,
  classifyPoolWindows,
  collectLimitRecoveries,
  isHiddenAntigravityThirdPartyWindow,
  isSessionBlockedByPrimary,
  PREVIEW_EPHEMERAL_PARTITION_PREFIX,
  providerAuthWebviewPartition,
  shortWindowLabel,
  windowHealth,
} from "./usageLimitsHealth.ts";

const NOW_ISO = "2026-11-23T00:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const WEEK_MINS = 7 * 24 * 60;
const FIVE_HOURS_MINS = 5 * 60;
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function makeProvider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("default"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Code",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW_ISO,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("usageLimitsHealth", () => {
  it("drops Antigravity third-party (Claude & GPT) windows while keeping Gemini windows", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini · 5-hour",
        usedPercent: 23,
        windowDurationMins: FIVE_HOURS_MINS,
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini · Weekly",
        usedPercent: 44,
        windowDurationMins: WEEK_MINS,
      },
      {
        id: "3p-5h",
        kind: "session",
        label: "Claude & GPT (shared) · 5-hour",
        usedPercent: 0,
        windowDurationMins: FIVE_HOURS_MINS,
      },
      {
        id: "3p-weekly",
        kind: "weekly",
        label: "Claude & GPT (shared) · Weekly",
        usedPercent: 3,
        windowDurationMins: WEEK_MINS,
      },
    ];

    expect(isHiddenAntigravityThirdPartyWindow(antigravity, windows[2]!)).toBe(true);
    expect(isHiddenAntigravityThirdPartyWindow(antigravity, windows[3]!)).toBe(true);
    expect(isHiddenAntigravityThirdPartyWindow(antigravity, windows[1]!)).toBe(false);

    const classified = classifyAccountWindows(antigravity, windows);
    expect(classified.primary?.id).toBe("gemini-weekly");
    expect(classified.secondary.map((w) => w.id)).toEqual(["gemini-5h"]);
    expect(shortWindowLabel(antigravity, classified.primary!)).toBe("Weekly");
    expect(shortWindowLabel(antigravity, classified.secondary[0]!)).toBe("5-hour");
  });

  it("classifies Claude primary weekly, model-scoped weekly, and 5-hour sub-bars", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const windows: ServerProviderUsageWindow[] = [
      { id: "five_hour", kind: "session", label: "Session", usedPercent: 16 },
      { id: "seven_day_fable", kind: "weekly", label: "Weekly · Fable", usedPercent: 58 },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 43 },
    ];
    const classified = classifyAccountWindows(claude, windows);
    expect(classified.primary?.id).toBe("seven_day");
    expect(classified.secondary.map((w) => w.id)).toEqual(["seven_day_fable", "five_hour"]);
    expect(shortWindowLabel(claude, classified.secondary[0]!)).toBe("Fable weekly");
    expect(shortWindowLabel(claude, classified.secondary[1]!)).toBe("5-hour");
  });

  it("computes semantic health levels and burnout estimates from remaining % and pace", () => {
    // 5 days left in 7-day week => elapsed ~28.6%, pace mark ~71.4%
    const resetsIn5d = isoAt(NOW + 5 * 24 * 60 * 60_000);

    const healthy = windowHealth(
      {
        id: "w",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 10,
        resetsAt: resetsIn5d,
        windowDurationMins: WEEK_MINS,
      },
      NOW,
    );
    expect(healthy.level).toBe("ok");
    expect(healthy.remainingPercent).toBe(90);
    expect(healthy.burnoutMs).toBeNull();

    // 44% used at 28.6% elapsed => +15.4% ahead => warn + projects burnout
    const ahead = windowHealth(
      {
        id: "w",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 44,
        resetsAt: resetsIn5d,
        windowDurationMins: WEEK_MINS,
      },
      NOW,
    );
    expect(ahead.level).toBe("warn");
    expect(ahead.remainingPercent).toBe(56);
    expect(ahead.burnoutMs).not.toBeNull();
    expect(ahead.burnoutMs!).toBeGreaterThan(2 * 24 * 60 * 60_000);

    // 92% used => 8% left => bad
    const critical = windowHealth(
      {
        id: "w",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 92,
        resetsAt: resetsIn5d,
        windowDurationMins: WEEK_MINS,
      },
      NOW,
    );
    expect(critical.level).toBe("bad");

    // 100% used => depleted/off
    const depleted = windowHealth(
      {
        id: "w",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        resetsAt: resetsIn5d,
        windowDurationMins: WEEK_MINS,
      },
      NOW,
    );
    expect(depleted.level).toBe("off");
    expect(depleted.remainingPercent).toBe(0);
    expect(depleted.burnoutMs).toBeNull();
  });

  it("builds one unified semantic color and divider positions for a combined multi-account pool", () => {
    const resetsIn5d = isoAt(NOW + 5 * 24 * 60 * 60_000);
    const presentations = new Map([
      [
        EnvironmentId.make("local"),
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("claude_work"),
                auth: { status: "authenticated", email: "work@example.com" },
                usageLimits: {
                  checkedAt: NOW_ISO,
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 43,
                      resetsAt: resetsIn5d,
                      windowDurationMins: WEEK_MINS,
                    },
                  ],
                },
              }),
              makeProvider({
                instanceId: ProviderInstanceId.make("claude_personal"),
                auth: { status: "authenticated", email: "personal@example.com" },
                usageLimits: {
                  checkedAt: NOW_ISO,
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 1,
                      resetsAt: resetsIn5d,
                      windowDurationMins: WEEK_MINS,
                    },
                  ],
                },
              }),
            ],
          },
        },
      ],
    ]);

    const pools = collectLimitPools(collectLimitAccounts(presentations), NOW);
    expect(pools).toHaveLength(1);
    const { primary } = classifyPoolWindows(pools[0]!);
    expect(primary).not.toBeNull();

    const combined = buildCombinedPoolBar(primary!, NOW);
    // 57% + 99% across 2 equal accounts => 78% left; 22% used < 28.6% elapsed => single "ok" color
    expect(combined.remainingPercent).toBe(78);
    expect(combined.level).toBe("ok");
    expect(combined.dividerPositions).toEqual([49.5]);
  });

  it("groups unauthenticated environments per driver and locates a healthy sync source", () => {
    const codex = ProviderDriverKind.make("codex");
    const presentations = new Map([
      [
        EnvironmentId.make("env-healthy"),
        {
          entry: { target: { label: "Primary" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("codex"),
                driver: codex,
                displayName: "Codex",
                status: "ready",
                auth: { status: "authenticated", email: "user@example.com" },
              }),
            ],
          },
        },
      ],
      [
        EnvironmentId.make("env-broken-1"),
        {
          entry: { target: { label: "dev-host-x" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("codex"),
                driver: codex,
                displayName: "Codex",
                status: "error",
                auth: { status: "unauthenticated" },
                message: "Codex CLI is not authenticated. Run `codex login` and try again.",
              }),
            ],
          },
        },
      ],
      [
        EnvironmentId.make("env-broken-2"),
        {
          entry: { target: { label: "host-x-wsl" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("codex"),
                driver: codex,
                displayName: "Codex",
                status: "error",
                auth: { status: "unauthenticated" },
                message: "Codex CLI is not authenticated. Run `codex login` and try again.",
              }),
            ],
          },
        },
      ],
    ]);

    const groups = collectLimitRecoveries(presentations);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.driver).toBe(codex);
    expect(groups[0]!.targets.map((t) => t.environmentLabel)).toEqual([
      "dev-host-x",
      "host-x-wsl",
    ]);
    expect(groups[0]!.syncSource?.environmentLabel).toBe("Primary");
  });

  it("derives an ephemeral webview partition matching the desktop webview gate prefix", () => {
    const partition = providerAuthWebviewPartition("flow/123:abc");
    expect(partition.startsWith(PREVIEW_EPHEMERAL_PARTITION_PREFIX)).toBe(true);
    expect(partition).toBe("t3code-preview-ephemeral-auth-flow123abc");
  });

  it("uses timed-only used % for combined pace and deduplicates zero-width dividers", () => {
    const resetsIn5d = isoAt(NOW + 5 * 24 * 60 * 60_000);
    const presentations = new Map([
      [
        EnvironmentId.make("local"),
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              // Untimed spent member (no resetsAt) + two healthy timed members + one depleted
              makeProvider({
                instanceId: ProviderInstanceId.make("c1"),
                auth: { status: "authenticated", email: "a@example.com" },
                usageLimits: {
                  checkedAt: NOW_ISO,
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 100,
                      windowDurationMins: WEEK_MINS,
                    },
                  ],
                },
              }),
              makeProvider({
                instanceId: ProviderInstanceId.make("c2"),
                auth: { status: "authenticated", email: "b@example.com" },
                usageLimits: {
                  checkedAt: NOW_ISO,
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 100,
                      windowDurationMins: WEEK_MINS,
                    },
                  ],
                },
              }),
              makeProvider({
                instanceId: ProviderInstanceId.make("c3"),
                auth: { status: "authenticated", email: "c@example.com" },
                usageLimits: {
                  checkedAt: NOW_ISO,
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 10,
                      resetsAt: resetsIn5d,
                      windowDurationMins: WEEK_MINS,
                    },
                  ],
                },
              }),
            ],
          },
        },
      ],
    ]);

    const pools = collectLimitPools(collectLimitAccounts(presentations), NOW);
    const primary = classifyPoolWindows(pools[0]!).primary!;
    const combined = buildCombinedPoolBar(primary, NOW);
    // Remaining is 30% overall (>25%), timed member is at 10% used vs 28.6% elapsed => ok, no false burnout
    expect(combined.remainingPercent).toBe(30);
    expect(combined.level).toBe("ok");
    expect(combined.burnoutMs).toBeNull();
    // Divider positions are strictly unique
    expect(new Set(combined.dividerPositions).size).toBe(combined.dividerPositions.length);
  });

  it("matches poolMember suppression rules for session sub-bars", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const codex = ProviderDriverKind.make("codex");
    const antigravity = ProviderDriverKind.make("antigravity");
    const session = { id: "five_hour", kind: "session" as const };
    expect(
      isSessionBlockedByPrimary(
        claude,
        { id: "seven_day", kind: "weekly", usedPercent: 100 },
        session,
      ),
    ).toBe(true);
    expect(
      isSessionBlockedByPrimary(
        codex,
        { id: "secondary", kind: "weekly", usedPercent: 100 },
        session,
      ),
    ).toBe(true);
    expect(
      isSessionBlockedByPrimary(
        antigravity,
        { id: "gemini-weekly", kind: "weekly", usedPercent: 100 },
        { id: "gemini-5h", kind: "session" },
      ),
    ).toBe(false);
  });
});
