import {
  TUI_OUTPUT_PALETTES,
  type TuiColorScheme,
  type TuiPaletteTokens,
  type TuiProviderKey,
  type TuiProviderPaletteDefinition,
} from "./tuiOutputPaletteData";

export {
  TUI_OUTPUT_PALETTES,
  type TuiColorScheme,
  type TuiPaletteTokens,
  type TuiProviderKey,
  type TuiProviderPaletteDefinition,
};

const ANTIGRAVITY_PATTERN = /^(?:antigravity|agy)(?:$|[-_])/i;
const CLAUDE_PATTERN = /^(?:claude(?:agent|code)?)(?:$|[-_])/i;
const CODEX_PATTERN = /^(?:codex|openai[-_]codex)(?:$|[-_])/i;
const MUSE_PATTERN = /^muse(?:$|[-_])/i;

/**
 * Normalizes a provider driver kind, instance id, or session provider name into
 * one of the supported per-TUI palette keys.
 */
export function resolveTuiProviderKey(provider: string | null | undefined): TuiProviderKey {
  const trimmed = provider?.trim();
  if (!trimmed) {
    return "default";
  }

  if (trimmed === "antigravity" || ANTIGRAVITY_PATTERN.test(trimmed)) {
    return "antigravity";
  }
  if (trimmed === "claudeAgent" || CLAUDE_PATTERN.test(trimmed)) {
    return "claudeAgent";
  }
  if (trimmed === "codex" || CODEX_PATTERN.test(trimmed)) {
    return "codex";
  }
  if (trimmed === "muse" || MUSE_PATTERN.test(trimmed)) {
    return "muse";
  }
  return "default";
}

export function resolveEffectiveTuiProvider(
  provider: string | null | undefined,
  followProviderPalettes: boolean,
): TuiProviderKey {
  return followProviderPalettes ? resolveTuiProviderKey(provider) : "default";
}

export function getTuiPaletteTokens(
  provider: string | null | undefined,
  colorScheme: TuiColorScheme,
  followProviderPalettes = true,
): TuiPaletteTokens {
  const key = resolveEffectiveTuiProvider(provider, followProviderPalettes);
  return TUI_OUTPUT_PALETTES[key][colorScheme];
}
