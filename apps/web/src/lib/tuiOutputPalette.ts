export type TuiProviderKey = "antigravity" | "claudeAgent" | "codex" | "muse" | "default";

export type TuiColorScheme = "dark" | "light";

export interface TuiPaletteTokens {
  readonly accent: string;
  readonly fg: string;
  readonly fgMuted: string;
  readonly rail: string;
  readonly pillBg: string;
  readonly pillBorder: string;
  readonly path: string;
  readonly cmd: string;
  readonly flag: string;
  readonly symbol: string;
  readonly literal: string;
  readonly ok: string;
  readonly warn: string;
  readonly err: string;
  readonly diffAddFg: string;
  readonly diffAddBg: string;
  readonly diffDelFg: string;
  readonly diffDelBg: string;
  readonly ansi: readonly [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
}

export interface TuiProviderPaletteDefinition {
  readonly id: TuiProviderKey;
  readonly label: string;
  readonly dark: TuiPaletteTokens;
  readonly light: TuiPaletteTokens;
}

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

/**
 * Canonical per-provider TUI token palettes for dark and light themes.
 * Keep in sync with `[data-provider="..."]` custom properties in `index.css`.
 */
export const TUI_OUTPUT_PALETTES: Readonly<Record<TuiProviderKey, TuiProviderPaletteDefinition>> = {
  claudeAgent: {
    id: "claudeAgent",
    label: "Claude Code",
    dark: {
      accent: "#d97757",
      fg: "#eeeae2",
      fgMuted: "#a69f91",
      rail: "rgb(217 119 87 / 38%)",
      pillBg: "rgb(217 119 87 / 10%)",
      pillBorder: "rgb(217 119 87 / 24%)",
      path: "#8fbcbb",
      cmd: "#e89172",
      flag: "#e5c07b",
      symbol: "#d0a5d8",
      literal: "#d4a973",
      ok: "#7cc994",
      warn: "#f0c674",
      err: "#e06c75",
      diffAddFg: "#86d19c",
      diffAddBg: "rgb(124 201 148 / 12%)",
      diffDelFg: "#ea868d",
      diffDelBg: "rgb(224 108 117 / 12%)",
      ansi: [
        "#282522",
        "#e06c75",
        "#7cc994",
        "#e5c07b",
        "#7ea6d9",
        "#c994cf",
        "#56b6c2",
        "#dfd9cf",
        "#7d746b",
        "#f08b92",
        "#98daa9",
        "#f0c674",
        "#9bc0ec",
        "#dfb1e4",
        "#7dcfff",
        "#faf9f5",
      ],
    },
    light: {
      accent: "#c25937",
      fg: "#2c241e",
      fgMuted: "#6e645b",
      rail: "rgb(194 89 55 / 32%)",
      pillBg: "rgb(194 89 55 / 7%)",
      pillBorder: "rgb(194 89 55 / 22%)",
      path: "#1f6f7a",
      cmd: "#b84a27",
      flag: "#9c5f0b",
      symbol: "#7d4289",
      literal: "#8f6214",
      ok: "#237340",
      warn: "#9c6108",
      err: "#b8322f",
      diffAddFg: "#1f6b3a",
      diffAddBg: "rgb(40 115 68 / 10%)",
      diffDelFg: "#b3302d",
      diffDelBg: "rgb(184 50 47 / 10%)",
      ansi: [
        "#2c241e",
        "#b8322f",
        "#237340",
        "#9c6108",
        "#255c99",
        "#7d4289",
        "#1f6f7a",
        "#5c534b",
        "#786e65",
        "#c9403c",
        "#2c874d",
        "#ad6f0e",
        "#326fb3",
        "#9452a1",
        "#268491",
        "#1f1914",
      ],
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    dark: {
      accent: "#38bdf8",
      fg: "#e5ecf4",
      fgMuted: "#8e9db2",
      rail: "rgb(56 189 248 / 36%)",
      pillBg: "rgb(56 189 248 / 9%)",
      pillBorder: "rgb(56 189 248 / 24%)",
      path: "#61d6d6",
      cmd: "#6aa9ff",
      flag: "#5eead4",
      symbol: "#ad7bf9",
      literal: "#f6c453",
      ok: "#40c977",
      warn: "#f5b841",
      err: "#fa423e",
      diffAddFg: "#40c977",
      diffAddBg: "rgb(64 201 119 / 12%)",
      diffDelFg: "#fa5c58",
      diffDelBg: "rgb(250 66 62 / 12%)",
      ansi: [
        "#1b222c",
        "#e74856",
        "#16c60c",
        "#c19c00",
        "#3b78ff",
        "#ad7bf9",
        "#3a96dd",
        "#cccccc",
        "#767676",
        "#ff6b66",
        "#40c977",
        "#f9f1a5",
        "#6aa9ff",
        "#c39cfb",
        "#61d6d6",
        "#f2f2f2",
      ],
    },
    light: {
      accent: "#0284c7",
      fg: "#18202c",
      fgMuted: "#5b6778",
      rail: "rgb(2 132 199 / 32%)",
      pillBg: "rgb(2 132 199 / 7%)",
      pillBorder: "rgb(2 132 199 / 22%)",
      path: "#0369a1",
      cmd: "#1d4ed8",
      flag: "#0f766e",
      symbol: "#7c3aed",
      literal: "#a16207",
      ok: "#008a36",
      warn: "#b45309",
      err: "#ba2623",
      diffAddFg: "#008a36",
      diffAddBg: "rgb(0 162 64 / 10%)",
      diffDelFg: "#ba2623",
      diffDelBg: "rgb(186 38 35 / 10%)",
      ansi: [
        "#18202c",
        "#ba2623",
        "#008a36",
        "#a16207",
        "#1d4ed8",
        "#7c3aed",
        "#0369a1",
        "#475569",
        "#64748b",
        "#d93834",
        "#00a240",
        "#b45309",
        "#2563eb",
        "#924ff7",
        "#0284c7",
        "#0f172a",
      ],
    },
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    dark: {
      accent: "#8c7bd1",
      fg: "#e8eaf6",
      fgMuted: "#969cc0",
      rail: "rgb(140 123 209 / 40%)",
      pillBg: "rgb(140 123 209 / 11%)",
      pillBorder: "rgb(140 123 209 / 26%)",
      path: "#56d7c6",
      cmd: "#93a8ff",
      flag: "#b89eff",
      symbol: "#74c0fc",
      literal: "#ecc16f",
      ok: "#54d69c",
      warn: "#efb758",
      err: "#f07488",
      diffAddFg: "#54d69c",
      diffAddBg: "rgb(84 214 156 / 12%)",
      diffDelFg: "#f28596",
      diffDelBg: "rgb(240 116 136 / 12%)",
      ansi: [
        "#1e2130",
        "#f07488",
        "#54d69c",
        "#efb758",
        "#7a8cff",
        "#b89eff",
        "#56d7c6",
        "#d1d5eb",
        "#6f7598",
        "#f58fa0",
        "#74e2b1",
        "#f6cb78",
        "#98a8ff",
        "#cbb8ff",
        "#76e3d5",
        "#f3f5ff",
      ],
    },
    light: {
      accent: "#5b4bc4",
      fg: "#191c2b",
      fgMuted: "#585f80",
      rail: "rgb(91 75 196 / 32%)",
      pillBg: "rgb(91 75 196 / 7%)",
      pillBorder: "rgb(91 75 196 / 22%)",
      path: "#0f766e",
      cmd: "#4338ca",
      flag: "#6d28d9",
      symbol: "#0369a1",
      literal: "#9a5b04",
      ok: "#047857",
      warn: "#b45309",
      err: "#be123c",
      diffAddFg: "#047857",
      diffAddBg: "rgb(4 120 87 / 10%)",
      diffDelFg: "#be123c",
      diffDelBg: "rgb(190 18 60 / 10%)",
      ansi: [
        "#191c2b",
        "#be123c",
        "#047857",
        "#9a5b04",
        "#4338ca",
        "#6d28d9",
        "#0f766e",
        "#4a506e",
        "#686f8f",
        "#d82350",
        "#059669",
        "#b45309",
        "#4f46e5",
        "#7c3aed",
        "#0d9488",
        "#111320",
      ],
    },
  },
  muse: {
    id: "muse",
    label: "Muse",
    dark: {
      accent: "#3b9eff",
      fg: "#eaf1fb",
      fgMuted: "#96a8c4",
      rail: "rgb(0 129 251 / 42%)",
      pillBg: "rgb(0 129 251 / 11%)",
      pillBorder: "rgb(59 158 255 / 28%)",
      path: "#38d9c0",
      cmd: "#58a6ff",
      flag: "#c084fc",
      symbol: "#79c0ff",
      literal: "#f2b866",
      ok: "#4ade80",
      warn: "#fbbf24",
      err: "#fb7185",
      diffAddFg: "#4ade80",
      diffAddBg: "rgb(74 222 128 / 12%)",
      diffDelFg: "#fb7185",
      diffDelBg: "rgb(251 113 133 / 12%)",
      ansi: [
        "#172030",
        "#fb7185",
        "#4ade80",
        "#fbbf24",
        "#3b9eff",
        "#c084fc",
        "#38d9c0",
        "#d3dff0",
        "#6b7f9e",
        "#fda4af",
        "#6ee7b7",
        "#fde68a",
        "#79c0ff",
        "#d8b4fe",
        "#5eead4",
        "#f3f7ff",
      ],
    },
    light: {
      accent: "#0064e1",
      fg: "#141d2e",
      fgMuted: "#55647d",
      rail: "rgb(0 100 225 / 32%)",
      pillBg: "rgb(0 100 225 / 7%)",
      pillBorder: "rgb(0 100 225 / 22%)",
      path: "#0f766e",
      cmd: "#0052bd",
      flag: "#7e22ce",
      symbol: "#0369a1",
      literal: "#b45309",
      ok: "#15803d",
      warn: "#a16207",
      err: "#be123c",
      diffAddFg: "#15803d",
      diffAddBg: "rgb(21 128 61 / 10%)",
      diffDelFg: "#be123c",
      diffDelBg: "rgb(190 18 60 / 10%)",
      ansi: [
        "#141d2e",
        "#be123c",
        "#15803d",
        "#9a6204",
        "#0052bd",
        "#7e22ce",
        "#0f766e",
        "#475569",
        "#64748b",
        "#db2757",
        "#16a34a",
        "#b45309",
        "#0081fb",
        "#9333ea",
        "#0d9488",
        "#0b111c",
      ],
    },
  },
  default: {
    id: "default",
    label: "Default",
    dark: {
      accent: "#78a9ff",
      fg: "#e4e4e7",
      fgMuted: "#9ca3af",
      rail: "rgb(148 163 184 / 32%)",
      pillBg: "rgb(148 163 184 / 9%)",
      pillBorder: "rgb(148 163 184 / 22%)",
      path: "#67d2e8",
      cmd: "#78a9ff",
      flag: "#eab308",
      symbol: "#c084fc",
      literal: "#f59e0b",
      ok: "#4ade80",
      warn: "#fbbf24",
      err: "#f87171",
      diffAddFg: "#4ade80",
      diffAddBg: "rgb(74 222 128 / 12%)",
      diffDelFg: "#f87171",
      diffDelBg: "rgb(248 113 113 / 12%)",
      ansi: [
        "#18181b",
        "#e05252",
        "#4ec970",
        "#e5b94c",
        "#5b8ff9",
        "#c678dd",
        "#4ec2d6",
        "#d4d4d8",
        "#71717a",
        "#f87171",
        "#6ee78e",
        "#facc15",
        "#7ba8ff",
        "#da98f0",
        "#67d8eb",
        "#fafafa",
      ],
    },
    light: {
      accent: "#2563eb",
      fg: "#27272a",
      fgMuted: "#6b7280",
      rail: "rgb(100 116 139 / 28%)",
      pillBg: "rgb(100 116 139 / 7%)",
      pillBorder: "rgb(100 116 139 / 20%)",
      path: "#0e7490",
      cmd: "#2563eb",
      flag: "#9a5b04",
      symbol: "#7c3aed",
      literal: "#b45309",
      ok: "#15803d",
      warn: "#b45309",
      err: "#dc2626",
      diffAddFg: "#15803d",
      diffAddBg: "rgb(21 128 61 / 10%)",
      diffDelFg: "#dc2626",
      diffDelBg: "rgb(220 38 38 / 10%)",
      ansi: [
        "#18181b",
        "#dc2626",
        "#15803d",
        "#9a5b04",
        "#2563eb",
        "#7c3aed",
        "#0e7490",
        "#52525b",
        "#71717a",
        "#ef4444",
        "#16a34a",
        "#b45309",
        "#3b82f6",
        "#9333ea",
        "#0891b2",
        "#09090b",
      ],
    },
  },
};

export function getTuiPaletteTokens(
  provider: string | null | undefined,
  colorScheme: TuiColorScheme,
  followProviderPalettes = true,
): TuiPaletteTokens {
  const key = resolveEffectiveTuiProvider(provider, followProviderPalettes);
  return TUI_OUTPUT_PALETTES[key][colorScheme];
}
