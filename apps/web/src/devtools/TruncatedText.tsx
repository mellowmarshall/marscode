/**
 * Truncated / line-clamped text that shows T3's tooltip with the full text on
 * hover or keyboard focus whenever the rendered text overflows its box.
 */
import { useEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

function isElementOverflowing(el: HTMLElement | null, text: string): boolean {
  if (!el || text.length === 0) return false;
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

export function TruncatedText({
  text,
  tooltip,
  as = "div",
  className,
  variant = "default",
  side = "top",
}: {
  readonly text: string;
  readonly tooltip?: string | undefined;
  readonly as?: "div" | "span";
  readonly className?: string | undefined;
  readonly variant?: "default" | "code";
  readonly side?: "top" | "bottom" | "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const elRef = useRef<HTMLElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs overflow state with shared ResizeObserver layout measurements
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const sync = () => {
      const next = isElementOverflowing(el, text);
      setOverflows(next);
      if (!next) setOpen(false);
    };
    sync();
    return observeResize(el, sync);
  }, [text]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setOpen(false);
      return;
    }
    const next = isElementOverflowing(elRef.current, text);
    setOverflows(next);
    setOpen(next);
  };

  const Tag = as;
  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger
        render={
          <Tag
            ref={(node: HTMLElement | null) => {
              elRef.current = node;
            }}
            tabIndex={overflows ? 0 : undefined}
            className={className}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup side={side} variant={variant}>
        {tooltip ?? text}
      </TooltipPopup>
    </Tooltip>
  );
}
