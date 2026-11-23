import type { OutputHighlightingMode } from "@t3tools/contracts/settings";
import { Fragment, memo, type CSSProperties } from "react";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { getTuiPaletteTokens, type TuiProviderKey } from "~/lib/tuiOutputPalette";
import { tokenizeTerminalOutputLines, type TerminalOutputSpan } from "~/lib/tuiTerminalTokenizer";
import { cn } from "~/lib/utils";
import { useTuiProvider } from "./TuiProviderContext";

interface TerminalOutputTextProps {
  readonly text: string;
  readonly mode?: OutputHighlightingMode;
  readonly provider?: TuiProviderKey | string | null | undefined;
  readonly preNormalized?: boolean;
  readonly className?: string;
}

function spanClassName(span: TerminalOutputSpan): string | undefined {
  if (!span.role || span.role === "plain") {
    return undefined;
  }
  return `tui-term-token tui-term-token-${span.role}`;
}

function buildKeyedTerminalLines(
  text: string,
  mode: OutputHighlightingMode,
  palette: ReadonlyArray<string>,
  preNormalized: boolean,
) {
  const parsedLines = tokenizeTerminalOutputLines(text, { mode, palette, preNormalized });
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
  mode,
  provider,
  preNormalized = false,
  className,
}: TerminalOutputTextProps) {
  const resolvedTheme = useRenderedAppearance();
  const contextProvider = useTuiProvider();
  const providerTuiPalettes = useClientSettings((settings) => settings.providerTuiPalettes);
  const storedMode = useClientSettings((settings) => settings.outputHighlightingMode);

  const effectiveMode = mode ?? storedMode;
  const effectiveProvider = provider ?? contextProvider;
  const palette = getTuiPaletteTokens(effectiveProvider, resolvedTheme, providerTuiPalettes).ansi;
  const keyedLines = buildKeyedTerminalLines(text, effectiveMode, palette, preNormalized);

  return (
    <span className={cn("tui-term-output", className)} data-tui-highlighting={effectiveMode}>
      {keyedLines.map((line, lineIndex) => {
        const isLastLine = lineIndex === keyedLines.length - 1;
        return (
          <Fragment key={line.key}>
            {line.spans.map(({ key, span }) => {
              const style = span.style as CSSProperties | undefined;
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
