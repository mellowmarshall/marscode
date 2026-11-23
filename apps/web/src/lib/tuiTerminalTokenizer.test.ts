import { describe, expect, it } from "vite-plus/test";
import { TUI_OUTPUT_PALETTES } from "./tuiOutputPalette";
import {
  hasAnsiSequences,
  stripAnsiSequences,
  tokenizeTerminalOutputLines,
} from "./tuiTerminalTokenizer";

describe("ANSI sequence detection and stripping", () => {
  it("detects and strips CSI and OSC escape sequences while preserving text", () => {
    const raw =
      "\u001b[1;31mERROR\u001b[0m: \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007";
    expect(hasAnsiSequences(raw)).toBe(true);
    expect(hasAnsiSequences("plain log output")).toBe(false);
    expect(stripAnsiSequences(raw)).toBe("ERROR: link");
  });

  it("resolves 16-color provider palettes, 256-color, truecolor, and text attributes", () => {
    const claudePalette = TUI_OUTPUT_PALETTES.claudeAgent.dark.ansi;
    const raw =
      "\u001b[1;3;4;9;31merr\u001b[0m " +
      "\u001b[38;5;196;48;2;10;20;30mrgb\u001b[0m " +
      "\u001b[7;2mrev\u001b[27;22m";
    const [line] = tokenizeTerminalOutputLines(raw, {
      mode: "ansi",
      palette: claudePalette,
    });
    expect(line).toBeDefined();
    expect(line!.spans.map((span) => span.text).join("")).toBe("err rgb rev");

    const errSpan = line!.spans[0]!;
    expect(errSpan.style?.fontWeight).toBe("600");
    expect(errSpan.style?.fontStyle).toBe("italic");
    expect(errSpan.style?.textDecorationLine).toBe("underline line-through");
    expect(errSpan.style?.color).toBe(claudePalette[1]);

    const rgbSpan = line!.spans[2]!;
    expect(rgbSpan.style?.color).toBe("rgb(255,0,0)");
    expect(rgbSpan.style?.backgroundColor).toBe("rgb(10,20,30)");

    const revSpan = line!.spans[4]!;
    expect(revSpan.style?.backgroundColor).toBe(claudePalette[7]);
    expect(revSpan.style?.opacity).toBe(0.65);
  });
});

describe("tokenizeTerminalOutputLines", () => {
  it("preserves exact plain text across semantic, ansi, and off modes", () => {
    const sample = [
      "$ pnpm --filter @t3tools/web test NODE_ENV=test",
      "2026-11-16T20:00:00Z INFO Running src/lib/tuiTerminalTokenizer.test.ts:12",
      "WARN deprecated flag --legacy",
      "ERROR failed at apps/web/src/index.css:40:2",
      '  "status": "ok",',
      "diff --git a/a.ts b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-const oldVal = 1;",
      "+const newVal = 2;",
      "PASS 42 tests",
    ].join("\n");

    for (const mode of ["semantic", "ansi", "off"] as const) {
      const lines = tokenizeTerminalOutputLines(sample, {
        mode,
        palette: TUI_OUTPUT_PALETTES.codex.dark.ansi,
      });
      expect(lines.map((line) => line.spans.map((s) => s.text).join("")).join("\n")).toBe(sample);
    }

    const semanticLines = tokenizeTerminalOutputLines(sample, {
      mode: "semantic",
      palette: TUI_OUTPUT_PALETTES.codex.dark.ansi,
    });
    const cmdLineRoles = semanticLines[0]!.spans.map((s) => s.role).filter(Boolean);
    expect(cmdLineRoles).toContain("prompt");
    expect(cmdLineRoles).toContain("cmd");
    expect(cmdLineRoles).toContain("flag");

    const infoLineRoles = semanticLines[1]!.spans.map((s) => s.role).filter(Boolean);
    expect(infoLineRoles).toContain("timestamp");
    expect(infoLineRoles).toContain("info");
    expect(infoLineRoles).toContain("path");

    expect(semanticLines[2]!.spans.some((s) => s.role === "warn")).toBe(true);
    expect(semanticLines[3]!.spans.some((s) => s.role === "err")).toBe(true);
    expect(semanticLines[4]!.spans.some((s) => s.role === "symbol")).toBe(true);
    expect(semanticLines[4]!.spans.some((s) => s.role === "literal")).toBe(true);
    expect(semanticLines[6]!.lineRole).toBe("diff-hunk");
    expect(semanticLines[7]!.lineRole).toBe("diff-del");
    expect(semanticLines[8]!.lineRole).toBe("diff-add");
    expect(semanticLines[9]!.spans.some((s) => s.role === "ok")).toBe(true);
  });

  it("does not overwrite explicit ANSI foreground colors during semantic pass", () => {
    const palette = TUI_OUTPUT_PALETTES.muse.dark.ansi;
    const sample = "\u001b[32mPASS\u001b[0m apps/web/src/index.css";
    const [line] = tokenizeTerminalOutputLines(sample, { mode: "semantic", palette });
    expect(line).toBeDefined();
    expect(line!.spans[0]!.style?.color).toBe(palette[2]);
    expect(line!.spans[0]!.role).toBeUndefined();
    expect(line!.spans.some((span) => span.role === "path")).toBe(true);
  });

  it("normalizes bare carriage returns, URLs, badge contrast, and span caps", () => {
    expect(stripAnsiSequences("progress 10%\rprogress 100%")).toBe("progress 100%");
    const [crLine] = tokenizeTerminalOutputLines("\u001b[33m10%\r\u001b[32m100%", {
      mode: "ansi",
      palette: TUI_OUTPUT_PALETTES.default.dark.ansi,
    });
    expect(crLine!.spans.map((s) => s.text).join("")).toBe("100%");

    const [urlLine] = tokenizeTerminalOutputLines("See https://example.com/a/b.ts for logs", {
      mode: "semantic",
      palette: TUI_OUTPUT_PALETTES.default.dark.ansi,
    });
    expect(
      urlLine!.spans.some((s) => s.role === "url" && s.text === "https://example.com/a/b.ts"),
    ).toBe(true);
    expect(urlLine!.spans.some((s) => s.role === "path")).toBe(false);

    const [badgeLine] = tokenizeTerminalOutputLines("\u001b[42m PASS \u001b[0m", {
      mode: "ansi",
      palette: TUI_OUTPUT_PALETTES.codex.dark.ansi,
    });
    expect(badgeLine!.spans[0]!.style?.backgroundColor).toBe(
      TUI_OUTPUT_PALETTES.codex.dark.ansi[2],
    );
    expect(badgeLine!.spans[0]!.style?.color).toBe("#1f2328");

    const huge = Array.from(
      { length: 1500 },
      (_, i) => `\u001b[31mA${i}\u001b[32mB${i}\u001b[0m`,
    ).join("\n");
    const parsed = tokenizeTerminalOutputLines(huge, {
      mode: "ansi",
      palette: TUI_OUTPUT_PALETTES.default.dark.ansi,
    });
    const totalSpans = parsed.reduce((acc, line) => acc + line.spans.length, 0);
    expect(totalSpans).toBeLessThan(2600);
    expect(parsed[1499]!.spans.map((s) => s.text).join("")).toBe("A1499B1499");
  });
});
