import { render } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const BUILT_IN = "## T3 Code orchestration\n\nOrdinary coding tasks need no T3 tools.";

const state = vi.hoisted(() => ({
  agentInstructions: "",
  scopeKind: "all" as string,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    agentInstructions: state.agentInstructions,
  })) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: state.scopeKind },
    target: { environmentId: EnvironmentId.make("env-agent-instructions") },
    targets: [{ environmentId: EnvironmentId.make("env-agent-instructions") }],
  })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const defaults = Atom.make(() => ({
    _tag: "Success",
    value: { text: BUILT_IN },
    waiting: false,
  }));
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      defaultAgentInstructions: (() => defaults) as never,
    },
  };
});
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ children, resetAction }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
}));

import { AgentInstructionsSettings } from "./AgentInstructionsSettings";

const setup = (agentInstructions: string, scopeKind = "all") => {
  state.agentInstructions = agentInstructions;
  state.scopeKind = scopeKind;
  state.updateSettings.mockReset();
};

describe("AgentInstructionsSettings", () => {
  it("shows the server's built-in text and saves an edit, but not the unchanged text", async () => {
    setup("");
    await using screen = await render(<AgentInstructionsSettings />, { router: false });
    const editor = screen.getByRole("textbox", { name: "Agent instructions" });
    await expect.element(editor).toHaveValue(BUILT_IN);
    expect(
      screen.getByRole("button", { name: "Reset agent instructions to default" }).query(),
    ).toBe(null);

    await userEvent.fill(editor, `${BUILT_IN}\n`);
    await userEvent.click(document.body);
    expect(state.updateSettings).not.toHaveBeenCalled();

    await userEvent.fill(editor, `${BUILT_IN}\n\nAsk before deleting files.`);
    await userEvent.click(document.body);
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      agentInstructions: `${BUILT_IN}\n\nAsk before deleting files.`,
    });
  });

  it("shows an edit and resets it to the built-in text", async () => {
    setup("Ask before deleting files.");
    await using screen = await render(<AgentInstructionsSettings />, { router: false });
    await expect
      .element(screen.getByRole("textbox", { name: "Agent instructions" }))
      .toHaveValue("Ask before deleting files.");

    await userEvent.click(
      page.getByRole("button", { name: "Reset agent instructions to default" }),
    );
    expect(state.updateSettings).toHaveBeenLastCalledWith({ agentInstructions: "" });
  });

  it("is absent from project settings, where it cannot be stored", async () => {
    setup("", "project");
    await using screen = await render(<AgentInstructionsSettings />, { router: false });
    expect(screen.getByRole("textbox", { name: "Agent instructions" }).query()).toBe(null);
  });
});
