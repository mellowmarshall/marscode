import { Fragment, memo, type CSSProperties } from "react";
import { useRenderedAppearance } from "~/hooks/useTheme";
import {
  ansiColorToCss,
  resolveAnsiBadgeContrastColor,
  tokenizeTerminalOutputLines,
  type AnsiTextStyle,
  type TerminalOutputSpan,
} from "~/lib/tuiOutputHighlighting";
import type { TuiColorScheme } from "~/lib/tuiOutputPalette";
import type { OutputHighlightingMode } from "~/lib/tuiOutputPreferences";
import { cn } from "~/lib/utils";

interface TerminalOutputTextProps {
  readonly text: string;
  readonly mode?: OutputHighlightingMode;
  readonly className?: string;
}

function buildAnsiInlineStyle(
  ansi: AnsiTextStyle | undefined,
  theme: TuiColorScheme,
): CSSProperties | undefined {
  if (!ansi) return undefined;
  const style: CSSProperties = {};
  let hasProperties = false;

  if (ansi.reverse) {
    style.color = ansi.bg ? ansiColorToCss(ansi.bg) : "var(--code-background, var(--background))";
    style.backgroundColor = ansi.fg ? ansiColorToCss(ansi.fg) : "var(--tui-fg, var(--foreground))";
    if (ansi.fg) {
      const contrastFg = resolveAnsiBadgeContrastColor(ansi.fg, ansi.bg, theme);
      if (contrastFg) style.color = contrastFg;
    }
    hasProperties = true;
  } else {
    if (ansi.fg) {
      style.color = ansiColorToCss(ansi.fg);
      hasProperties = true;
    }
    if (ansi.bg) {
      style.backgroundColor = ansiColorToCss(ansi.bg);
      const contrastFg = resolveAnsiBadgeContrastColor(ansi.bg, ansi.fg, theme);
      if (contrastFg) {
        style.color = contrastFg;
      }
      hasProperties = true;
    }
  }

  if (ansi.bold) {
    style.fontWeight = 600;
    hasProperties = true;
  }
  if (ansi.dim) {
    style.opacity = 0.65;
    hasProperties = true;
  }
  if (ansi.italic) {
    style.fontStyle = "italic";
    hasProperties = true;
  }
  if (ansi.underline && ansi.strikethrough) {
    style.textDecorationLine = "underline line-through";
    hasProperties = true;
  } else if (ansi.underline) {
    style.textDecorationLine = "underline";
    hasProperties = true;
  } else if (ansi.strikethrough) {
    style.textDecorationLine = "line-through";
    hasProperties = true;
  }

  return hasProperties ? style : undefined;
}

function spanClassName(span: TerminalOutputSpan): string | undefined {
  if (!span.role || span.role === "plain") {
    return undefined;
  }
  return `tui-term-token tui-term-token-${span.role}`;
}

function buildKeyedTerminalLines(text: string, mode: OutputHighlightingMode) {
  const parsedLines = tokenizeTerminalOutputLines(text, mode);
  let cursor = 0;
  return parsedLines.map((line) => {
    const lineKey = `L${cursor}`;
    const keyedSpans = line.spans.map((span) => {
      const spanKey = `S${cursor}`;
      cursor += span.text.length;
      return { key: spanKey, span };
    });
    cursor += 1;
    return { key: lineKey, lineRole: line.lineRole, spans: keyedSpans };
  });
}

export const TerminalOutputText = memo(function TerminalOutputText({
  text,
  mode = "semantic",
  className,
}: TerminalOutputTextProps) {
  const resolvedTheme = useRenderedAppearance();
  const keyedLines = buildKeyedTerminalLines(text, mode);

  return (
    <span className={cn("tui-term-output", className)} data-tui-highlighting={mode}>
      {keyedLines.map((line, lineIndex) => {
        const isLastLine = lineIndex === keyedLines.length - 1;
        return (
          <Fragment key={line.key}>
            {line.spans.map(({ key, span }) => {
              const style = buildAnsiInlineStyle(span.ansi, resolvedTheme);
              const tokenClass = spanClassName(span);
              if (!style && !tokenClass && !line.lineRole) {
                return <Fragment key={key}>{span.text}</Fragment>;
              }
              return (
                <span
                  key={key}
                  className={tokenClass}
                  data-tui-role={span.role && span.role !== "plain" ? span.role : undefined}
                  data-tui-line-role={line.lineRole}
                  style={style}
                >
                  {span.text}
                </span>
              );
            })}
            {!isLastLine ? "\n" : null}
          </Fragment>
        );
      })}
    </span>
  );
});
