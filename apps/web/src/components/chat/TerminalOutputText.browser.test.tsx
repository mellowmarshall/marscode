import "~/index.css";
import type { OutputHighlightingMode } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  TUI_OUTPUT_PALETTES,
  type TuiColorScheme,
  type TuiProviderKey,
} from "~/lib/tuiOutputPalette";
import { render } from "../../../test/render";
import ChatMarkdown from "../ChatMarkdown";
import { TerminalOutputText } from "./TerminalOutputText";
import { TuiProviderContext } from "./TuiProviderContext";

const appearance = vi.hoisted(() => ({
  value: "dark" as TuiColorScheme,
  listeners: new Set<() => void>(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    appearance.listeners.add(listener);
    return () => appearance.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useRenderedAppearance: () => useSyncExternalStore(subscribe, () => appearance.value),
  };
});

const settingsOverrides = vi.hoisted(() => ({
  providerTuiPalettes: true,
  outputHighlightingMode: "semantic" as OutputHighlightingMode,
}));

vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

function hexToRgbCss(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function withAppearanceCleanup() {
  return {
    [Symbol.dispose]() {
      document.documentElement.classList.remove("dark");
      document.documentElement.removeAttribute("data-theme-id");
      appearance.value = "dark";
      settingsOverrides.providerTuiPalettes = true;
      settingsOverrides.outputHighlightingMode = "semantic";
    },
  };
}

describe("TerminalOutputText & provider TUI palettes", () => {
  it("applies provider-specific ANSI and semantic CSS palette colors across light and dark modes", async () => {
    using _cleanup = withAppearanceCleanup();
    const sample = "\u001b[31mFAIL\u001b[0m apps/web/src/index.css OK";
    const providers: ReadonlyArray<TuiProviderKey> = [
      "claudeAgent",
      "codex",
      "antigravity",
      "muse",
    ];

    for (const scheme of ["dark", "light"] as const) {
      appearance.value = scheme;
      if (scheme === "dark") {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }

      for (const provider of providers) {
        const expected = TUI_OUTPUT_PALETTES[provider][scheme];
        await using screen = await render(
          <div data-provider={provider}>
            <TuiProviderContext value={provider}>
              <TerminalOutputText text={sample} />
            </TuiProviderContext>
          </div>,
        );
        const failSpan = screen.getByText("FAIL").element();
        const pathSpan = screen.getByText("apps/web/src/index.css").element();
        const okSpan = screen.getByText("OK").element();

        expect(getComputedStyle(failSpan).color).toBe(hexToRgbCss(expected.ansi[1]));
        expect(getComputedStyle(pathSpan).color).toBe(hexToRgbCss(expected.path));
        expect(getComputedStyle(okSpan).color).toBe(hexToRgbCss(expected.ok));
      }
    }
  });

  it("falls back to default palette when providerTuiPalettes is disabled", async () => {
    using _cleanup = withAppearanceCleanup();
    document.documentElement.classList.add("dark");
    appearance.value = "dark";
    settingsOverrides.providerTuiPalettes = false;
    const expectedDefault = TUI_OUTPUT_PALETTES.default.dark;

    await using screen = await render(
      <div data-provider="default">
        <TuiProviderContext value="claudeAgent">
          <TerminalOutputText text={"\u001b[31mFAIL\u001b[0m apps/web/src/index.css"} />
        </TuiProviderContext>
      </div>,
    );

    expect(getComputedStyle(screen.getByText("FAIL").element()).color).toBe(
      hexToRgbCss(expectedDefault.ansi[1]),
    );
    expect(getComputedStyle(screen.getByText("apps/web/src/index.css").element()).color).toBe(
      hexToRgbCss(expectedDefault.path),
    );
  });

  it("highlights assistant inline code pills even under t3-chat light theme while keeping off-mode plain", async () => {
    using _cleanup = withAppearanceCleanup();
    document.documentElement.setAttribute("data-theme-id", "t3-chat");
    appearance.value = "light";

    await using screen = await render(
      <div data-provider="codex">
        <div data-testid="assistant-md">
          <ChatMarkdown cwd={undefined} text="Run `git status` in `apps/web/src/index.css`." />
        </div>
        <div data-testid="user-md">
          <ChatMarkdown
            cwd={undefined}
            text="Check `git status` in `apps/web/src/index.css`."
            outputHighlightingMode="off"
          />
        </div>
      </div>,
    );

    const assistantRoot = screen.getByTestId("assistant-md").element();
    const userRoot = screen.getByTestId("user-md").element();
    const assistantPathCode = assistantRoot.querySelector('code[data-tui-role="path"]');
    const assistantCmdCode = assistantRoot.querySelector('code[data-tui-role="cmd"]');
    expect(assistantPathCode).not.toBeNull();
    expect(assistantCmdCode).not.toBeNull();
    expect(getComputedStyle(assistantPathCode!).color).toBe(
      hexToRgbCss(TUI_OUTPUT_PALETTES.codex.light.path),
    );
    expect(userRoot.querySelector("code[data-tui-role]")).toBeNull();
  });
});
