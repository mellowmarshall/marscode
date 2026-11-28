/**
 * Slots for the Fleet console's side-by-side tables (host load, localhosts). Each panel fills its
 * column and scrolls its own rows, so the console itself never scrolls on a wide screen.
 */
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

function Root({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "@container flex min-h-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-card/40",
        className,
      )}
      {...props}
    />
  );
}

function Header({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5",
        className,
      )}
      {...props}
    />
  );
}

function Title({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn(
        "flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** A table row's column template; header and rows pass the same `className` grid. */
function Columns({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="row"
      className={cn(
        "grid shrink-0 items-center gap-x-3 border-b border-border/50 bg-muted/20 px-3 py-1 text-xs font-medium text-muted-foreground [&>*:not(:first-child)]:text-right",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 flex-1 divide-y divide-border/50 overflow-y-auto", className)}
      {...props}
    />
  );
}

function Group({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 bg-muted/15 px-3 py-1 text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-24 flex-1 items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

type LoadTone = "warn" | "bad" | undefined;

function loadTone(share: number | null): LoadTone {
  if (share === null) return undefined;
  if (share >= 0.8) return "bad";
  if (share >= 0.5) return "warn";
  return undefined;
}

/** A load value led by a short bar showing its share of the host (0..1). */
function Meter({ text, share }: { readonly text: string; readonly share: number | null }) {
  const tone = loadTone(share);
  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      {share !== null ? (
        <span className="hidden h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-muted-foreground/15 @lg:block">
          <span
            className={cn(
              "block h-full rounded-full",
              tone === "bad" ? "bg-destructive" : tone === "warn" ? "bg-warning" : "bg-info/80",
            )}
            style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
          />
        </span>
      ) : null}
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          tone === "bad"
            ? "font-semibold text-destructive-foreground"
            : tone === "warn"
              ? "font-semibold text-warning-foreground"
              : "text-foreground",
        )}
      >
        {text}
      </span>
    </div>
  );
}

export const FleetPanel = { Root, Header, Title, Columns, Body, Group, Empty, Meter };
