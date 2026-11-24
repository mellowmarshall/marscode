import {
  type LimitPool,
  type LimitPoolWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import {
  buildCombinedPoolBar,
  classifyPoolWindows,
  shortWindowLabel,
} from "@t3tools/shared/usageLimitsHealth";
import { formatDuration, formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { T, useGT, useMessages } from "gt-react";

import { cn } from "../../lib/utils";
import {
  AccountIdentityLabel,
  healthTextClass,
  SemanticMainBar,
  SemanticSubBar,
} from "./UsageLimitsBars";

export interface BarInspection {
  readonly key: string;
  readonly title: string;
  readonly summary: string;
}

export function InspectionStrip({
  inspection,
  onClose,
}: {
  readonly inspection: BarInspection;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  return (
    <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-secondary/70 px-2.5 py-2 text-xs text-muted-foreground">
      <strong className="font-semibold text-foreground">{inspection.title}</strong>
      <span>{inspection.summary}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={gt("Close details")}
        className="ms-auto inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
      >
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}

export function CombinedPoolView({
  pool,
  customNames,
  onRename,
  now,
  inspected,
  onInspect,
}: {
  readonly pool: LimitPool;
  readonly customNames: Readonly<Record<string, string>>;
  readonly onRename: (accountKey: string, nextName: string) => void;
  readonly now: number;
  readonly inspected: BarInspection | null;
  readonly onInspect: (next: BarInspection | null) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { primary, secondary } = classifyPoolWindows(pool);
  if (!primary) return null;

  const combinedPrimary = buildCombinedPoolBar(primary, now);
  const primaryLabel = shortWindowLabel(pool.driver, primary);
  const primaryReset = combinedPrimary.earliestResetWindow
    ? formatResetsIn(combinedPrimary.earliestResetWindow, now, m, "refill")
    : null;
  const poolPrefix = `pool:${pool.driver}`;
  const poolInspection = inspected?.key.startsWith(`${poolPrefix}:`) ? inspected : null;

  const inspectPoolWindow = (key: string, title: string, poolWindow: LimitPoolWindow) => {
    if (inspected?.key === key) {
      onInspect(null);
      return;
    }
    const breakdown = poolWindow.members.map((member, index) => {
      const custom = customNames[member.account.key]?.trim();
      const display = member.account.displayName?.trim();
      const safeDisplay = display && !display.includes("@") ? display : null;
      const name = custom || safeDisplay || gt("Account {index}", { index: index + 1 });
      return `${name}: ${remainingPercent(member.window)}%`;
    });
    onInspect({ key, title, summary: breakdown.join(" · ") });
  };

  const primaryKey = `${poolPrefix}:${primary.id}`;

  return (
    <div className="grid items-center gap-x-5 gap-y-2 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-muted-foreground">
          {gt("{label} · {count} accounts", {
            label: primaryLabel,
            count: pool.accounts.length,
          })}
        </span>
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-2xl leading-tight font-semibold tracking-tight tabular-nums",
              healthTextClass(combinedPrimary.level),
            )}
          >
            {combinedPrimary.remainingPercent}%
          </span>
          <span className="text-xs text-muted-foreground">
            <T context="remaining usage percentage">left</T>
          </span>
        </div>
        {combinedPrimary.burnoutMs !== null ? (
          <span
            className={cn(
              "text-2xs tabular-nums",
              combinedPrimary.level === "bad"
                ? "text-destructive-foreground"
                : "text-warning-foreground",
            )}
          >
            {gt("Runs out in ~{duration} at pace", {
              duration: formatDuration(combinedPrimary.burnoutMs, m),
            })}
          </span>
        ) : (
          <span className="text-2xs text-muted-foreground">
            {combinedPrimary.level === "off" ? gt("All accounts depleted") : gt("Combined pool")}
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <SemanticMainBar
          remainingPercent={combinedPrimary.remainingPercent}
          level={combinedPrimary.level}
          paceRemainingPercent={combinedPrimary.paceRemainingPercent}
          resetLabel={primaryReset}
          dividerPositions={combinedPrimary.dividerPositions}
          ariaLabel={gt("{label} combined: {remaining}% left", {
            label: primaryLabel,
            remaining: combinedPrimary.remainingPercent,
          })}
          selected={inspected?.key === primaryKey}
          onClick={() => inspectPoolWindow(primaryKey, primaryLabel, primary)}
        />
        {secondary.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {secondary.map((subPool) => {
              const subCombined = buildCombinedPoolBar(subPool, now);
              const subLabel = shortWindowLabel(pool.driver, subPool);
              const subReset = subCombined.earliestResetWindow
                ? formatResetsIn(subCombined.earliestResetWindow, now, m, "refill")
                : null;
              const subKey = `${poolPrefix}:${subPool.id}`;
              return (
                <SemanticSubBar
                  key={`${subPool.kind}:${subPool.id}`}
                  label={subLabel}
                  remainingPercent={subCombined.remainingPercent}
                  level={subCombined.level}
                  paceRemainingPercent={subCombined.paceRemainingPercent}
                  resetLabel={subReset}
                  dividerPositions={subCombined.dividerPositions}
                  ariaLabel={gt("{label} combined: {remaining}% left", {
                    label: subLabel,
                    remaining: subCombined.remainingPercent,
                  })}
                  selected={inspected?.key === subKey}
                  onClick={() => inspectPoolWindow(subKey, subLabel, subPool)}
                />
              );
            })}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pt-0.5 text-2xs text-muted-foreground">
          {primary.members.map((member) => (
            <span key={member.account.key} className="inline-flex min-w-0 items-center gap-1.5">
              <AccountIdentityLabel
                account={member.account}
                customName={customNames[member.account.key]}
                onRename={onRename}
              />
              <span className="font-mono text-2xs font-semibold text-foreground tabular-nums">
                {remainingPercent(member.window)}%
              </span>
            </span>
          ))}
        </div>
      </div>

      {poolInspection ? (
        <InspectionStrip inspection={poolInspection} onClose={() => onInspect(null)} />
      ) : null}
    </div>
  );
}
