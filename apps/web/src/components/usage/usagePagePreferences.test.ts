import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  patchUsagePagePreferences,
  readUsagePagePreferences,
  saveUsagePagePreferences,
} from "./usagePagePreferences";

const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Usage page preferences", () => {
  it("round-trips hidden providers, combined drivers, and custom account names", () => {
    saveUsagePagePreferences({
      metric: "cost",
      windowDays: 7,
      hiddenProviders: ["codex"],
      combinedLimitDrivers: ["claudeAgent"],
      limitAccountNames: { "claudeAgent:work@example.com": "Work" },
    });
    const saved = readUsagePagePreferences();
    expect(saved.hiddenProviders).toEqual(["codex"]);
    expect(saved.combinedLimitDrivers).toEqual(["claudeAgent"]);
    expect(saved.limitAccountNames).toEqual({ "claudeAgent:work@example.com": "Work" });

    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
  });

  // regression: #10189 an invalid saved usage selection was never replaced
  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "limits", windowDays: 30 });
    saveUsagePagePreferences({ metric: "tokens", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 7 });
  });

  it("preserves account names and combined toggles when another usage preference changes", () => {
    saveUsagePagePreferences({ metric: "limits", windowDays: 30 });
    patchUsagePagePreferences({
      combinedLimitDrivers: ["claudeAgent"],
      limitAccountNames: { "claudeAgent:work@example.com": "Work" },
    });
    const afterWindowChange = patchUsagePagePreferences({ windowDays: 7 });
    expect(afterWindowChange.windowDays).toBe(7);
    expect(afterWindowChange.combinedLimitDrivers).toEqual(["claudeAgent"]);
    expect(afterWindowChange.limitAccountNames).toEqual({
      "claudeAgent:work@example.com": "Work",
    });
  });
});
