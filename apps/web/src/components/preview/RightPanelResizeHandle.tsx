import type { KeyboardEvent } from "react";
import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;

interface Props {
  handlers: ResizableWidthHandlers;
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  /** Receives keyboard resizes; pointer drags go through `handlers`. */
  onWidthChange: (width: number) => void;
  className?: string;
}

/** A focusable separator on the left edge of a right-hand panel; ArrowLeft widens it. */
export function RightPanelResizeHandle({
  handlers,
  label,
  width,
  minWidth,
  maxWidth,
  onWidthChange,
  className,
}: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    let nextWidth: number;
    switch (event.key) {
      case "ArrowLeft":
        nextWidth = width + step;
        break;
      case "ArrowRight":
        nextWidth = width - step;
        break;
      case "Home":
        nextWidth = minWidth;
        break;
      case "End":
        nextWidth = maxWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    onWidthChange(nextWidth);
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "group absolute inset-y-0 left-0 z-40 w-1 cursor-col-resize touch-none select-none any-pointer-coarse:-left-2 any-pointer-coarse:w-4",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60 any-pointer-coarse:left-2"
      />
    </div>
  );
}
