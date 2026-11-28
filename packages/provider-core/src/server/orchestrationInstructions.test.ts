import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  setT3OrchestrationInstructionsOverride,
  splitOrchestrationSections,
  t3AcpPromptWithInstructions,
  t3OrchestrationInstructionsText,
  t3OrchestrationPrompt,
  t3OrchestrationSections,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");

    // A provider's own guidance reaches a conversation that already had the rest.
    const providerRun = (providerInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        providerInstructions: "Mark awaited shells.",
        providerInstructionsDelivered,
      });
    assert.include(providerRun(false), "Mark awaited shells.");
    assert.notInclude(providerRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(providerRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

describe("T3 modal guidance", () => {
  it("routes sudo through request_secret and owner approvals through a re-run with HOST_GUARD_OVERRIDE", () => {
    for (const rule of [
      "never ask in chat or give the user a terminal command.",
      "run `sudo -S -p '' <cmd> < \"$file\"` yourself",
      're-run the exact command yourself as `HOST_GUARD_OVERRIDE="<why, in words>" <command>`',
      "`HOST_GUARD_OVERRIDE_PLAN=<plan.json>` or `marscode-guard override --plan`",
      "Only for owner decisions, not failures you can fix.",
    ]) {
      assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, rule);
    }
  });

  it("keeps every built-in section under Codex's per-entry cap", () => {
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      assert.isAtMost(new TextEncoder().encode(section).byteLength, 4_000);
    }
  });

  it("documents the 30 min pre-merge hold and ship-queue resume flow", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, 'ship-queue resume <job> --reason "<why>"');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "held 30 min");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ship-queue override");
  });
});

describe("T3 instructions edited in settings", () => {
  it("replace the built-in text for every provider path, and an empty edit restores it", () => {
    setT3OrchestrationInstructionsOverride("  ## House rules\n\nAsk before deleting files.  ");
    try {
      assert.equal(
        t3OrchestrationInstructionsText(),
        "## House rules\n\nAsk before deleting files.",
      );
      assert.deepEqual(t3OrchestrationSections(), ["## House rules\n\nAsk before deleting files."]);
      assert.include(t3OrchestrationSystemPrompt(true, false)!, "Ask before deleting files.");
      assert.notInclude(t3OrchestrationSystemPrompt(true, false)!, "## T3 Code orchestration");
      const state = { interactionMode: "default" as const, hasT3Mcp: true, hasDeviceTools: false };
      assert.include(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "Ask before deleting");
    } finally {
      setT3OrchestrationInstructionsOverride("");
    }
    assert.equal(t3OrchestrationInstructionsText(), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.strictEqual(t3OrchestrationSections(), T3_CODE_ORCHESTRATION_SECTIONS);
  });

  it("split long text into Codex-sized entries without losing any of it", () => {
    const paragraph = "word ".repeat(300).trim();
    const longLine = "é".repeat(2_500);
    const text = [paragraph, paragraph, paragraph, longLine].join("\n\n");
    const sections = splitOrchestrationSections(text);
    for (const section of sections) {
      assert.isAtMost(new TextEncoder().encode(section).byteLength, 4_000);
    }
    assert.equal(sections.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
    assert.isAbove(sections.length, 1);
  });
});
