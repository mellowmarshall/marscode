// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  getTuiPaletteTokens,
  resolveEffectiveTuiProvider,
  resolveTuiProviderKey,
  TUI_OUTPUT_PALETTES,
  type TuiProviderKey,
} from "./tuiOutputPalette";

describe("tuiOutputPalette", () => {
  it("normalizes driver names and instance ids across all supported providers", () => {
    expect(resolveTuiProviderKey("claudeAgent")).toBe("claudeAgent");
    expect(resolveTuiProviderKey("claude-default")).toBe("claudeAgent");
    expect(resolveTuiProviderKey("claude-code-2")).toBe("claudeAgent");
    expect(resolveTuiProviderKey("codex")).toBe("codex");
    expect(resolveTuiProviderKey("codex-default")).toBe("codex");
    expect(resolveTuiProviderKey("openai-codex")).toBe("codex");
    expect(resolveTuiProviderKey("antigravity")).toBe("antigravity");
    expect(resolveTuiProviderKey("agy-local")).toBe("antigravity");
    expect(resolveTuiProviderKey("muse")).toBe("muse");
    expect(resolveTuiProviderKey("muse-dev")).toBe("muse");
    expect(resolveTuiProviderKey("unknown-driver")).toBe("default");
    expect(resolveTuiProviderKey(null)).toBe("default");
    expect(resolveTuiProviderKey(undefined)).toBe("default");
  });

  it("falls back to default palette when provider TUI palettes are disabled", () => {
    expect(resolveEffectiveTuiProvider("claudeAgent", true)).toBe("claudeAgent");
    expect(resolveEffectiveTuiProvider("claudeAgent", false)).toBe("default");
    expect(getTuiPaletteTokens("muse", "dark", false)).toEqual(TUI_OUTPUT_PALETTES.default.dark);
    expect(getTuiPaletteTokens("codex", "light", true)).toEqual(TUI_OUTPUT_PALETTES.codex.light);
  });

  it("defines 16 ANSI colors and CSS custom property parity with index.css", () => {
    const cssText = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../index.css"),
      "utf8",
    );
    const keys: ReadonlyArray<TuiProviderKey> = [
      "claudeAgent",
      "codex",
      "antigravity",
      "muse",
      "default",
    ];
    for (const key of keys) {
      const palette = TUI_OUTPUT_PALETTES[key];
      expect(palette.dark.ansi).toHaveLength(16);
      expect(palette.light.ansi).toHaveLength(16);
      expect(cssText).toContain(`[data-provider="${key}"]`);
      expect(cssText).toContain(`.dark [data-provider="${key}"]`);
      expect(cssText).toContain(`--tui-accent: ${palette.light.accent};`);
      expect(cssText).toContain(`--tui-accent: ${palette.dark.accent};`);
    }
  });
});
