import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";
const resetsIn5d = "2026-10-30T16:00:00.000Z";
const resetsIn3h = "2026-10-25T19:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

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
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function cleanStorage(): Disposable {
  window.localStorage.clear();
  return {
    [Symbol.dispose]() {
      window.localStorage.clear();
    },
  };
}

describe("UsageLimitsPooled", () => {
  it("names the managed ChatGPT connections it covers", async () => {
    using _storage = cleanStorage();
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });

  it("drops Antigravity 3P Claude & GPT bars and renders Gemini weekly with a thin 5-hour sub-bar", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("antigravity"),
                driver: ProviderDriverKind.make("antigravity"),
                displayName: "Antigravity",
                usageLimits: {
                  checkedAt,
                  windows: [
                    {
                      id: "gemini-weekly",
                      kind: "weekly",
                      label: "Gemini · Weekly",
                      usedPercent: 44,
                      resetsAt: resetsIn5d,
                      windowDurationMins: 7 * 24 * 60,
                    },
                    {
                      id: "gemini-5h",
                      kind: "session",
                      label: "Gemini · 5-hour",
                      usedPercent: 23,
                      resetsAt: resetsIn3h,
                      windowDurationMins: 5 * 60,
                    },
                    {
                      id: "3p-weekly",
                      kind: "weekly",
                      label: "Claude & GPT (shared) · Weekly",
                      usedPercent: 3,
                      resetsAt: resetsIn5d,
                      windowDurationMins: 7 * 24 * 60,
                    },
                    {
                      id: "3p-5h",
                      kind: "session",
                      label: "Claude & GPT (shared) · 5-hour",
                      usedPercent: 0,
                      resetsAt: resetsIn3h,
                      windowDurationMins: 5 * 60,
                    },
                  ],
                },
              }),
            ],
          },
        },
      ],
    ]);

    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("Antigravity")).toBeVisible();
    await expect.element(screen.getByText("56%")).toBeVisible();
    await expect.element(screen.getByText("5-hour")).toBeVisible();
    await expect.element(screen.getByText("77%")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Claude & GPT");
  });

  it("defaults multi-account Claude to stacked, supports naming/blurring, and toggles to combined pool", async () => {
    using _storage = cleanStorage();
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("claude_work"),
                auth: { status: "authenticated", email: "work@example.com" },
                usageLimits: {
                  checkedAt,
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 43,
                      resetsAt: resetsIn5d,
                      windowDurationMins: 7 * 24 * 60,
                    },
                    {
                      id: "five_hour",
                      kind: "session",
                      label: "Session",
                      usedPercent: 16,
                      resetsAt: resetsIn3h,
                      windowDurationMins: 5 * 60,
                    },
                  ],
                },
              }),
              makeProvider({
                instanceId: ProviderInstanceId.make("claude_personal"),
                auth: { status: "authenticated", email: "personal@example.com" },
                usageLimits: {
                  checkedAt,
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 1,
                      resetsAt: resetsIn5d,
                      windowDurationMins: 7 * 24 * 60,
                    },
                  ],
                },
              }),
            ],
          },
        },
      ],
    ]);

    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    // Stacked by default shows both accounts separately and keeps emails redacted until revealed
    await expect.element(screen.getByText("57%")).toBeVisible();
    await expect.element(screen.getByText("99%")).toBeVisible();
    expect(screen.container.textContent).not.toContain("work@example.com");

    // Switch to Combined pool via toggle
    await screen.getByRole("button", { name: "Combined" }).click();
    await expect.element(screen.getByText("78%")).toBeVisible();
    await expect.element(screen.getByText("Combined pool")).toBeVisible();

    // Rename the first account inline
    const renameButtons = screen.getByRole("button", { name: "Rename account" }).all();
    await renameButtons[0]!.click();
    const input = screen.getByRole("textbox", { name: "Account name" });
    await input.fill("Work");
    await screen.getByRole("button", { name: "Save account name" }).click();
    await expect.element(screen.getByText("Work")).toBeVisible();
  });

  it("renders inline in-app sign-in recovery for unauthenticated Codex environments", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("env-1"),
        {
          entry: { target: { label: "host-b" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("codex"),
                driver: ProviderDriverKind.make("codex"),
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
        EnvironmentId.make("env-2"),
        {
          entry: { target: { label: "host-c-wsl" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("codex"),
                driver: ProviderDriverKind.make("codex"),
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

    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("2 environments need Codex sign-in")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Sign in in T3" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "host-b" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "host-c-wsl" })).toBeVisible();
  });
});
