import { describe, expect, it } from "vite-plus/test";
import {
  ansiColorToCss,
  classifyInlineCodeRole,
  hasAnsiSequences,
  parseAnsiLines,
  resolveAnsiBadgeContrastColor,
  stripAnsiSequences,
  tokenizeTerminalOutputLines,
  xterm256IndexToRgb,
} from "./tuiOutputHighlighting";

describe("classifyInlineCodeRole", () => {
  it("classifies paths, commands, flags, symbols, literals, and plain text", () => {
    expect(classifyInlineCodeRole("apps/web/src/index.css")).toBe("path");
    expect(classifyInlineCodeRole("./scripts/build.ts:42:7")).toBe("path");
    expect(classifyInlineCodeRole("pnpm --filter @t3tools/web build")).toBe("cmd");
    expect(classifyInlineCodeRole("git status")).toBe("cmd");
    expect(classifyInlineCodeRole("--frozen-lockfile")).toBe("flag");
    expect(classifyInlineCodeRole("NODE_ENV=production")).toBe("flag");
    expect(classifyInlineCodeRole("TerminalOutputText")).toBe("symbol");
    expect(classifyInlineCodeRole("resolveTuiProviderKey()")).toBe("symbol");
    expect(classifyInlineCodeRole("true")).toBe("literal");
    expect(classifyInlineCodeRole("42")).toBe("literal");
    expect(classifyInlineCodeRole("hello world")).toBe("plain");
    expect(classifyInlineCodeRole("CI/CD")).toBe("plain");
    expect(classifyInlineCodeRole("React/Next")).toBe("plain");
    expect(classifyInlineCodeRole("HTTP/2")).toBe("plain");
    expect(classifyInlineCodeRole("src/index")).toBe("path");
  });
});

describe("ANSI SGR parsing and stripping", () => {
  it("detects and strips CSI and OSC escape sequences while preserving text", () => {
    const raw =
      "\u001b[1;31mERROR\u001b[0m: \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007";
    expect(hasAnsiSequences(raw)).toBe(true);
    expect(hasAnsiSequences("plain log output")).toBe(false);
    expect(stripAnsiSequences(raw)).toBe("ERROR: link");
  });

  it("parses 16-color, 256-color, truecolor, and text attributes", () => {
    const raw =
      "\u001b[1;3;4;9;31merr\u001b[0m " +
      "\u001b[38;5;196;48;2;10;20;30mrgb\u001b[0m " +
      "\u001b[7;2mrev\u001b[27;22m";
    const [line] = parseAnsiLines(raw);
    expect(line).toBeDefined();
    expect(line!.spans.map((span) => span.text).join("")).toBe("err rgb rev");

    const errSpan = line!.spans[0]!;
    expect(errSpan.ansi?.bold).toBe(true);
    expect(errSpan.ansi?.italic).toBe(true);
    expect(errSpan.ansi?.underline).toBe(true);
    expect(errSpan.ansi?.strikethrough).toBe(true);
    expect(errSpan.ansi?.fg).toEqual({ kind: "indexed", index: 1 });
    expect(ansiColorToCss(errSpan.ansi!.fg!)).toBe("var(--tui-ansi-1)");

    const rgbSpan = line!.spans[2]!;
    expect(rgbSpan.ansi?.fg).toEqual({ kind: "indexed", index: 196 });
    expect(ansiColorToCss(rgbSpan.ansi!.fg!)).toBe(xterm256IndexToRgb(196));
    expect(rgbSpan.ansi?.bg).toEqual({ kind: "rgb", r: 10, g: 20, b: 30 });
    expect(ansiColorToCss(rgbSpan.ansi!.bg!)).toBe("rgb(10 20 30)");

    const revSpan = line!.spans[4]!;
    expect(revSpan.ansi?.reverse).toBe(true);
    expect(revSpan.ansi?.dim).toBe(true);
  });
});

describe("tokenizeTerminalOutputLines", () => {
  it("preserves exact plain text across semantic, ansi, and off modes", () => {
    const sample = [
      "$ pnpm --filter @t3tools/web test NODE_ENV=test",
      "2026-11-16T20:00:00Z INFO Running src/lib/tuiOutputHighlighting.test.ts:12",
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
      const lines = tokenizeTerminalOutputLines(sample, mode);
      expect(lines.map((line) => line.spans.map((s) => s.text).join("")).join("\n")).toBe(sample);
    }

    const semanticLines = tokenizeTerminalOutputLines(sample, "semantic");
    const cmdLineRoles = semanticLines[0]!.spans.map((s) => s.role).filter(Boolean);
    expect(cmdLineRoles).toContain("prompt");
    expect(cmdLineRoles).toContain("cmd");
    expect(cmdLineRoles).toContain("flag");
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
    const sample = "\u001b[32mPASS\u001b[0m apps/web/src/index.css";
    const [line] = tokenizeTerminalOutputLines(sample, "semantic");
    expect(line).toBeDefined();
    expect(line!.spans[0]!.ansi?.fg).toEqual({ kind: "indexed", index: 2 });
    expect(line!.spans[0]!.role).toBeUndefined();
    expect(line!.spans.some((span) => span.role === "path")).toBe(true);
  });

  it("normalizes bare carriage returns, URLs, badge contrast, and span caps", () => {
    expect(stripAnsiSequences("progress 10%\rprogress 100%")).toBe("progress 100%");
    const [crLine] = parseAnsiLines("\u001b[33m10%\r\u001b[32m100%");
    expect(crLine!.spans.map((s) => s.text).join("")).toBe("100%");

    const [urlLine] = tokenizeTerminalOutputLines(
      "See https://example.com/a/b.ts for logs",
      "semantic",
    );
    expect(
      urlLine!.spans.some((s) => s.role === "url" && s.text === "https://example.com/a/b.ts"),
    ).toBe(true);
    expect(urlLine!.spans.some((s) => s.role === "path")).toBe(false);

    expect(resolveAnsiBadgeContrastColor({ kind: "indexed", index: 2 }, undefined, "dark")).toBe(
      "#1f2328",
    );
    expect(resolveAnsiBadgeContrastColor({ kind: "indexed", index: 1 }, undefined, "light")).toBe(
      "#ffffff",
    );

    const huge = Array.from(
      { length: 1500 },
      (_, i) => `\u001b[31mA${i}\u001b[32mB${i}\u001b[0m`,
    ).join("\n");
    const parsed = parseAnsiLines(huge);
    const totalSpans = parsed.reduce((acc, line) => acc + line.spans.length, 0);
    expect(totalSpans).toBeLessThan(2600);
    expect(parsed[1499]!.spans.map((s) => s.text).join("")).toBe("A1499B1499");
  });
});
