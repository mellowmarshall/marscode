import type { LimitAccount } from "@t3tools/shared/usageLimits";
import type { LimitHealthLevel } from "@t3tools/shared/usageLimitsHealth";
import { CheckIcon, PencilIcon } from "lucide-react";
import { useGT } from "gt-react";
import { type CSSProperties, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePaceMark } from "./UsageLimits";

function healthFillGradient(level: LimitHealthLevel): string | undefined {
  switch (level) {
    case "ok":
      return "linear-gradient(90deg, color-mix(in srgb, var(--success) 68%, var(--card)), var(--success))";
    case "warn":
      return "linear-gradient(90deg, color-mix(in srgb, var(--warning) 72%, var(--card)), var(--warning))";
    case "bad":
      return "linear-gradient(90deg, color-mix(in srgb, var(--destructive) 72%, var(--card)), var(--destructive))";
    case "off":
      return undefined;
  }
}

function healthSolidColor(level: LimitHealthLevel): string {
  switch (level) {
    case "ok":
      return "var(--success)";
    case "warn":
      return "var(--warning)";
    case "bad":
      return "var(--destructive)";
    case "off":
      return "var(--muted-foreground)";
  }
}

export function healthTextClass(level: LimitHealthLevel): string {
  switch (level) {
    case "ok":
      return "text-success-foreground";
    case "warn":
      return "text-warning-foreground";
    case "bad":
      return "text-destructive-foreground";
    case "off":
      return "text-muted-foreground";
  }
}

const HATCH_STYLE: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, var(--foreground) 0 1px, transparent 1px 6px)",
};

export function SemanticMainBar({
  remainingPercent,
  level,
  paceRemainingPercent,
  resetLabel,
  dividerPositions = [],
  ariaLabel,
  selected = false,
  onClick,
}: {
  readonly remainingPercent: number;
  readonly level: LimitHealthLevel;
  readonly paceRemainingPercent: number | null;
  readonly resetLabel: string | null;
  readonly dividerPositions?: readonly number[];
  readonly ariaLabel: string;
  readonly selected?: boolean;
  readonly onClick?: () => void;
}) {
  const [barRef, paceMark] = usePaceMark(paceRemainingPercent);
  const clamped = Math.max(0, Math.min(100, remainingPercent));
  const spent = Math.max(0, 100 - clamped);
  const fillBg = healthFillGradient(level);

  return (
    <button
      ref={barRef}
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={selected}
      style={paceMark?.gappedTrack}
      className={cn(
        "relative h-[18px] w-full min-w-0 cursor-pointer rounded-md bg-muted text-start outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "ring-1 ring-inset ring-ring",
      )}
    >
      <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
        <div className="absolute inset-0" style={paceMark?.gap}>
          {clamped > 0 && fillBg ? (
            <div
              className="absolute inset-y-0 left-0 rounded-md opacity-90 transition-[width] duration-200"
              style={{ width: `${clamped}%`, backgroundImage: fillBg }}
            />
          ) : null}
          {spent > 0 ? (
            <div
              className="pointer-events-none absolute inset-y-0 right-0 opacity-15"
              style={{ width: `${spent}%`, ...HATCH_STYLE }}
            />
          ) : null}
          {dividerPositions.map((pos) => (
            <span
              key={pos}
              className="pointer-events-none absolute inset-y-0 w-[1.5px] -translate-x-1/2"
              style={{
                left: `${pos}%`,
                backgroundColor: "color-mix(in srgb, var(--card) 55%, transparent)",
              }}
            />
          ))}
        </div>
      </div>
      {paceMark ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-y-px z-10 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={paceMark.tick}
        />
      ) : null}
      {resetLabel ? (
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 right-1 z-20 -translate-y-1/2 rounded-sm border border-border/60 bg-background/85 px-1.5 text-2xs leading-3.75 font-medium whitespace-nowrap tabular-nums",
            level === "off" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {resetLabel}
        </span>
      ) : null}
    </button>
  );
}

export function SemanticSubBar({
  label,
  remainingPercent,
  level,
  paceRemainingPercent,
  resetLabel,
  dividerPositions = [],
  ariaLabel,
  selected = false,
  onClick,
}: {
  readonly label: string;
  readonly remainingPercent: number;
  readonly level: LimitHealthLevel;
  readonly paceRemainingPercent: number | null;
  readonly resetLabel: string | null;
  readonly dividerPositions?: readonly number[];
  readonly ariaLabel: string;
  readonly selected?: boolean;
  readonly onClick?: () => void;
}) {
  const clamped = Math.max(0, Math.min(100, remainingPercent));
  const quiet = level === "ok" && clamped >= 95 && resetLabel === null;
  const fillColor = quiet ? "var(--muted-foreground)" : healthSolidColor(level);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={selected}
      className="group grid w-full min-w-0 cursor-pointer grid-cols-[5.5rem_minmax(0,1fr)_6.25rem] items-center gap-x-2.5 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="truncate text-2xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        {label}
      </span>
      <span className="relative h-1 w-full rounded-full bg-muted">
        <span aria-hidden className="absolute inset-0 overflow-hidden rounded-full">
          {clamped > 0 ? (
            <span
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-200"
              style={{
                width: `${clamped}%`,
                backgroundColor: fillColor,
                opacity: quiet ? 0.42 : level === "ok" ? 0.8 : 0.92,
              }}
            />
          ) : null}
          {dividerPositions.map((pos) => (
            <span
              key={pos}
              className="pointer-events-none absolute inset-y-0 w-[1.5px] -translate-x-1/2"
              style={{
                left: `${pos}%`,
                backgroundColor: "color-mix(in srgb, var(--card) 60%, transparent)",
              }}
            />
          ))}
        </span>
        {paceRemainingPercent !== null ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-y-0.5 w-[1.5px] -translate-x-1/2 rounded-full bg-foreground/80"
            style={{ left: `clamp(2px, ${paceRemainingPercent}%, calc(100% - 2px))` }}
          />
        ) : null}
      </span>
      <span className="flex items-center justify-end gap-1.5 font-mono text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
        <strong
          className={cn(
            "font-semibold",
            level === "warn"
              ? "text-warning-foreground"
              : level === "bad"
                ? "text-destructive-foreground"
                : level === "off" || quiet
                  ? "text-muted-foreground"
                  : "text-foreground",
          )}
        >
          {clamped}%
        </strong>
        {resetLabel ? <span>{resetLabel}</span> : null}
      </span>
    </button>
  );
}

export function AccountIdentityLabel({
  account,
  customName,
  onRename,
}: {
  readonly account: LimitAccount;
  readonly customName: string | undefined;
  readonly onRename: (accountKey: string, nextName: string) => void;
}) {
  const gt = useGT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(customName ?? "");
  const cancelledRef = useRef(false);

  const startEdit = () => {
    cancelledRef.current = false;
    setDraft(customName ?? "");
    setEditing(true);
  };

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    onRename(account.key, draft.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        <input
          type="text"
          value={draft}
          maxLength={32}
          autoFocus
          aria-label={gt("Account name")}
          placeholder={gt("Account name…")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelledRef.current = true;
              setEditing(false);
            }
          }}
          className="h-5 w-28 min-w-0 rounded-sm border border-ring bg-background px-1.5 text-2xs font-medium text-foreground outline-none"
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={commit}
          aria-label={gt("Save account name")}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <CheckIcon className="size-3" aria-hidden />
        </button>
      </span>
    );
  }

  const trimmedCustom = customName?.trim();
  const driverLabel = providerClients.get(account.driver)?.label ?? String(account.driver);
  const displayFallback =
    account.displayName?.trim() &&
    account.displayName.trim().toLowerCase() !== driverLabel.toLowerCase()
      ? account.displayName.trim()
      : null;

  const sensitiveDisplay =
    displayFallback && displayFallback.includes("@") ? displayFallback : null;
  const plainDisplay = sensitiveDisplay ? null : displayFallback;

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {trimmedCustom ? (
        <span className="truncate rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-2xs leading-none font-semibold text-foreground">
          {trimmedCustom}
        </span>
      ) : account.email || sensitiveDisplay ? (
        <RedactedSensitiveText
          key={account.email ?? sensitiveDisplay!}
          value={account.email ?? sensitiveDisplay!}
          ariaLabel={gt("Toggle account email visibility")}
          revealTooltip={gt("Click to reveal email")}
          hideTooltip={gt("Click to hide email")}
          className="max-w-36 truncate text-2xs"
        />
      ) : plainDisplay ? (
        <span className="truncate rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-2xs leading-none font-medium text-foreground">
          {plainDisplay}
        </span>
      ) : (
        <span className="truncate text-2xs font-medium text-muted-foreground">{driverLabel}</span>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={startEdit}
              aria-label={gt("Rename account")}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-secondary hover:text-foreground"
            />
          }
        >
          <PencilIcon className="size-3" aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {trimmedCustom ? gt("Rename account") : gt("Name this account")}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
