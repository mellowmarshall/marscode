import type { LimitAccount, LimitPool, ResetCreditChoice } from "@t3tools/shared/usageLimits";
import {
  classifyAccountWindows,
  isSessionBlockedByPrimary,
  type LimitRecoveryGroup,
  shortWindowLabel,
  windowHealth,
} from "@t3tools/shared/usageLimitsHealth";
import {
  formatDuration,
  formatResetsIn,
  resetCreditChoices,
} from "@t3tools/shared/usageLimitsCopy";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { TicketIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { ResetCreditDialog, useResetCredit } from "./UsageLimits";
import { UsageLimitsAuthRecovery } from "./UsageLimitsAuthRecovery";
import {
  AccountIdentityLabel,
  healthTextClass,
  SemanticMainBar,
  SemanticSubBar,
} from "./UsageLimitsBars";
import { type BarInspection, CombinedPoolView, InspectionStrip } from "./UsageLimitsCombinedView";

export type { BarInspection } from "./UsageLimitsCombinedView";

function RedeemCreditButton({
  account,
  now,
}: {
  readonly account: LimitAccount;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const redeemAt = account.redeem;
  const credits = account.limits.resetCredits;
  const redeem = useResetCredit(redeemAt!.environmentId);
  const choices = credits ? resetCreditChoices(credits, redeemAt!.input, now, true, m) : [];
  const nextChoice: ResetCreditChoice | undefined = choices.find((c) => c.availableCount > 0);
  if (!nextChoice) return null;

  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={redeem.busy || !redeem.canManageProviders}
        onClick={() => redeem.confirm(nextChoice)}
        className="ms-auto"
      >
        <TicketIcon className="size-3" aria-hidden />
        {redeem.busy
          ? gt("Using…")
          : gt("Use reset credit ({count})", { count: nextChoice.availableCount })}
      </Button>
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
    </>
  );
}

function AccountRow({
  account,
  showIdentity,
  customName,
  onRename,
  now,
  inspected,
  onInspect,
}: {
  readonly account: LimitAccount;
  readonly showIdentity: boolean;
  readonly customName: string | undefined;
  readonly onRename: (accountKey: string, nextName: string) => void;
  readonly now: number;
  readonly inspected: BarInspection | null;
  readonly onInspect: (next: BarInspection | null) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { primary, secondary } = classifyAccountWindows(account.driver, account.limits.windows);
  if (!primary) return null;

  const primaryHealth = windowHealth(primary, now);
  const primaryLabel = shortWindowLabel(account.driver, primary);
  const primaryReset = formatResetsIn(primary, now, m, "refill");
  const primaryResetFull = primary.resetsAt
    ? formatUpcomingTimestamp(primary.resetsAt, timestampFormat, now, undefined, m)
    : null;

  const toggleInspect = (key: string, title: string, window: ServerProviderUsageWindow) => {
    if (inspected?.key === key) {
      onInspect(null);
      return;
    }
    const h = windowHealth(window, now);
    const resetsAt = window.resetsAt
      ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)
      : null;
    const resetsIn = formatResetsIn(window, now, m, "in");
    const parts = [
      gt("{remaining}% left", { remaining: h.remainingPercent }),
      h.paceRemainingPercent !== null
        ? gt("even pace {pace}%", { pace: h.paceRemainingPercent })
        : null,
      resetsAt
        ? resetsIn
          ? gt("resets {at} ({in})", { at: resetsAt, in: resetsIn })
          : gt("resets {at}", { at: resetsAt })
        : null,
    ].filter(Boolean);
    onInspect({ key, title, summary: parts.join(" · ") });
  };

  const rowPrefix = `acct:${account.key}`;
  const rowInspection = inspected?.key.startsWith(`${rowPrefix}:`) ? inspected : null;
  const primaryKey = `${rowPrefix}:${primary.id}`;

  return (
    <div className="grid items-center gap-x-5 gap-y-2 py-3.5 first:pt-0 last:pb-0 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-0.5">
        {showIdentity ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <AccountIdentityLabel account={account} customName={customName} onRename={onRename} />
          </div>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">{primaryLabel}</span>
        )}
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-2xl leading-tight font-semibold tracking-tight tabular-nums",
              healthTextClass(primaryHealth.level),
            )}
          >
            {primaryHealth.remainingPercent}%
          </span>
          <span className="text-xs text-muted-foreground">
            {showIdentity
              ? gt("left · {label}", { label: primaryLabel.toLowerCase() })
              : gt("left")}
          </span>
        </div>
        {primaryHealth.burnoutMs !== null ? (
          <span
            className={cn(
              "text-2xs tabular-nums",
              primaryHealth.level === "bad"
                ? "text-destructive-foreground"
                : "text-warning-foreground",
            )}
          >
            {gt("Runs out in ~{duration} at pace", {
              duration: formatDuration(primaryHealth.burnoutMs, m),
            })}
          </span>
        ) : primaryHealth.level === "off" && primaryResetFull ? (
          <span className="text-2xs text-muted-foreground">
            {gt("Resets {at}", { at: primaryResetFull })}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <SemanticMainBar
          remainingPercent={primaryHealth.remainingPercent}
          level={primaryHealth.level}
          paceRemainingPercent={primaryHealth.paceRemainingPercent}
          resetLabel={primaryReset}
          ariaLabel={gt("{label}: {remaining}% left", {
            label: primaryLabel,
            remaining: primaryHealth.remainingPercent,
          })}
          selected={inspected?.key === primaryKey}
          onClick={() => toggleInspect(primaryKey, primaryLabel, primary)}
        />
        {secondary.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {secondary.map((window) => {
              const subLabel = shortWindowLabel(account.driver, window);
              const blockedByPrimary = isSessionBlockedByPrimary(account.driver, primary, window);
              const subHealth = windowHealth(window, now);
              const effectiveRem = blockedByPrimary ? 0 : subHealth.remainingPercent;
              const effectiveLevel = blockedByPrimary ? "off" : subHealth.level;
              const subReset = blockedByPrimary
                ? gt("blocked")
                : (formatResetsIn(window, now, m, "refill") ??
                  (effectiveRem >= 100 ? gt("idle") : null));
              const subKey = `${rowPrefix}:${window.id}`;
              return (
                <SemanticSubBar
                  key={window.id}
                  label={subLabel}
                  remainingPercent={effectiveRem}
                  level={effectiveLevel}
                  paceRemainingPercent={blockedByPrimary ? null : subHealth.paceRemainingPercent}
                  resetLabel={subReset}
                  ariaLabel={gt("{label}: {remaining}% left", {
                    label: subLabel,
                    remaining: effectiveRem,
                  })}
                  selected={inspected?.key === subKey}
                  onClick={() => toggleInspect(subKey, subLabel, window)}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {rowInspection ? (
        <InspectionStrip inspection={rowInspection} onClose={() => onInspect(null)} />
      ) : null}
    </div>
  );
}

export function ProviderLimitsCard({
  pool,
  recovery,
  combined,
  onToggleCombined,
  customNames,
  onRename,
  now,
  inspected,
  onInspect,
}: {
  readonly pool: LimitPool;
  readonly recovery: LimitRecoveryGroup | undefined;
  readonly combined: boolean;
  readonly onToggleCombined: (driver: string, next: boolean) => void;
  readonly customNames: Readonly<Record<string, string>>;
  readonly onRename: (accountKey: string, nextName: string) => void;
  readonly now: number;
  readonly inspected: BarInspection | null;
  readonly onInspect: (next: BarInspection | null) => void;
}) {
  const gt = useGT();
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const multiAccount = pool.accounts.length > 1;
  const redeemableAccount = pool.accounts.find(
    (account) => account.redeem && (account.limits.resetCredits?.availableCount ?? 0) > 0,
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ProviderInstanceIcon
            driverKind={pool.driver}
            displayName={label}
            indicatorBackground="var(--background)"
            className="size-5"
            iconClassName="size-4 text-foreground/80"
          />
          {label}
        </h2>
        {multiAccount ? (
          <span className="text-xs text-muted-foreground">
            {gt("{count} accounts", { count: pool.accounts.length })}
          </span>
        ) : null}
        {redeemableAccount ? <RedeemCreditButton account={redeemableAccount} now={now} /> : null}
        {multiAccount ? (
          <div
            role="group"
            aria-label={gt("{provider} account layout", { provider: label })}
            className="ms-auto inline-flex items-center gap-0.5 rounded-md border border-border bg-secondary p-0.5"
          >
            <button
              type="button"
              aria-pressed={!combined}
              onClick={() => onToggleCombined(String(pool.driver), false)}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-0.5 text-2xs font-medium transition-colors",
                !combined
                  ? "bg-card text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <T>Stacked</T>
            </button>
            <button
              type="button"
              aria-pressed={combined}
              onClick={() => onToggleCombined(String(pool.driver), true)}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-0.5 text-2xs font-medium transition-colors",
                combined
                  ? "bg-card text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <T>Combined</T>
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3.5 rounded-lg border border-border/70 bg-card p-4">
        {multiAccount && combined ? (
          <CombinedPoolView
            pool={pool}
            customNames={customNames}
            onRename={onRename}
            now={now}
            inspected={inspected}
            onInspect={onInspect}
          />
        ) : (
          <div className="flex flex-col divide-y divide-border/60">
            {pool.accounts.map((account) => (
              <AccountRow
                key={account.key}
                account={account}
                showIdentity={multiAccount || Boolean(customNames[account.key]?.trim())}
                customName={customNames[account.key]}
                onRename={onRename}
                now={now}
                inspected={inspected}
                onInspect={onInspect}
              />
            ))}
          </div>
        )}
        {recovery ? <UsageLimitsAuthRecovery group={recovery} /> : null}
      </div>
    </section>
  );
}
