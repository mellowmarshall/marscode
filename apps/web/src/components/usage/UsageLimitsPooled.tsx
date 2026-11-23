import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectLimitPools,
  unshownFailedHubAccounts,
} from "@t3tools/shared/usageLimits";
import {
  buildCombinedPoolBar,
  classifyAccountWindows,
  classifyPoolWindows,
  collectLimitRecoveries,
  windowHealth,
} from "@t3tools/shared/usageLimitsHealth";
import { collectExternalUsageLinks, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { OpenAI } from "../Icons";
import { providerClients } from "../settings/providerDriverMeta";
import { Alert, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { UsageLimitsAuthRecovery } from "./UsageLimitsAuthRecovery";
import { type BarInspection, ProviderLimitsCard } from "./UsageLimitsProviderCard";
import { patchUsagePagePreferences, readUsagePagePreferences } from "./usagePagePreferences";

export function UsageLimitsPooled({
  presentations,
  now,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const [combinedDrivers, setCombinedDrivers] = useState<ReadonlySet<string>>(
    () => new Set(readUsagePagePreferences().combinedLimitDrivers ?? []),
  );
  const [accountNames, setAccountNames] = useState<Readonly<Record<string, string>>>(
    () => readUsagePagePreferences().limitAccountNames ?? {},
  );
  const [inspected, setInspected] = useState<BarInspection | null>(null);

  const pools = collectLimitPools(collectLimitAccounts(presentations), now).filter(
    (pool) => classifyPoolWindows(pool).primary !== null,
  );
  const recoveries = collectLimitRecoveries(presentations);
  const recoveryByDriver = new Map(recoveries.map((group) => [group.driver, group]));
  const poolDrivers = new Set(pools.map((pool) => pool.driver));
  const standaloneRecoveries = recoveries.filter((group) => !poolDrivers.has(group.driver));
  const externalLinks = collectExternalUsageLinks(presentations, m);

  // Keep non-provider source errors and unshown failed hub accounts visible.
  const sourceNotices: string[] = [];
  const failedAccounts = unshownFailedHubAccounts(presentations);
  for (const presentation of presentations.values()) {
    const envLabel = presentation.entry.target.label;
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const subject = presentations.size > 1 ? `${envLabel} · ${source.label}` : source.label;
      if (source.error) {
        sourceNotices.push(`${subject}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        sourceNotices.push(gt("{source}: No accounts reported.", { source: subject }));
      } else {
        for (const account of source.accounts) {
          const name = failedAccounts.get(account);
          if (!name) continue;
          const notice = limitsNotice(account.usageLimits, m);
          if (notice) sourceNotices.push(`${subject} · ${name}: ${notice}`);
        }
      }
    }
  }

  const toggleCombined = (driver: string, nextCombined: boolean) => {
    const next = new Set(combinedDrivers);
    if (nextCombined) next.add(driver);
    else next.delete(driver);
    setCombinedDrivers(next);
    patchUsagePagePreferences({ combinedLimitDrivers: [...next] });
  };

  const renameAccount = (accountKey: string, nextName: string) => {
    const next = { ...accountNames };
    if (nextName) next[accountKey] = nextName;
    else delete next[accountKey];
    setAccountNames(next);
    patchUsagePagePreferences({ limitAccountNames: next });
  };

  let aheadOrTight = 0;
  let depleted = 0;
  for (const pool of pools) {
    if (pool.accounts.length > 1 && combinedDrivers.has(String(pool.driver))) {
      const primary = classifyPoolWindows(pool).primary;
      if (!primary) continue;
      const health = buildCombinedPoolBar(primary, now);
      if (health.level === "off") depleted += 1;
      else if (health.level === "warn" || health.level === "bad") aheadOrTight += 1;
    } else {
      for (const account of pool.accounts) {
        const primary = classifyAccountWindows(account.driver, account.limits.windows).primary;
        if (!primary) continue;
        const health = windowHealth(primary, now);
        if (health.level === "off") depleted += 1;
        else if (health.level === "warn" || health.level === "bad") aheadOrTight += 1;
      }
    }
  }
  const authIssueCount = recoveries.reduce(
    (sum, group) => sum + group.targets.filter((t) => t.reason === "unauthenticated").length,
    0,
  );

  const hasContent =
    pools.length > 0 ||
    standaloneRecoveries.length > 0 ||
    externalLinks.length > 0 ||
    sourceNotices.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {!hasContent ? (
        <p className="text-sm text-muted-foreground">
          <T>No provider on the selected environments reports subscription limits.</T>
        </p>
      ) : null}

      {pools.length > 0 || authIssueCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {aheadOrTight > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning-surface px-2 py-0.5 text-2xs font-medium text-warning-foreground tabular-nums">
              {gt("{count} ahead or low", { count: aheadOrTight })}
            </span>
          ) : null}
          {depleted > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-2xs font-medium text-muted-foreground tabular-nums">
              {gt("{count} depleted", { count: depleted })}
            </span>
          ) : null}
          {authIssueCount > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-2xs font-medium text-destructive-foreground tabular-nums">
              {gt("{count} need sign-in", { count: authIssueCount })}
            </span>
          ) : null}
          {aheadOrTight === 0 && depleted === 0 && authIssueCount === 0 && pools.length > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-2xs font-medium text-success-foreground">
              <T>All limits on pace</T>
            </span>
          ) : null}
        </div>
      ) : null}

      {pools.map((pool) => (
        <ProviderLimitsCard
          key={pool.driver}
          pool={pool}
          recovery={recoveryByDriver.get(pool.driver)}
          combined={combinedDrivers.has(String(pool.driver))}
          onToggleCombined={toggleCombined}
          customNames={accountNames}
          onRename={renameAccount}
          now={now}
          inspected={inspected}
          onInspect={setInspected}
        />
      ))}

      {standaloneRecoveries.map((group) => {
        const label = providerClients.get(group.driver)?.label ?? String(group.driver);
        return (
          <section key={group.driver} className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ProviderInstanceIcon
                driverKind={group.driver}
                displayName={label}
                indicatorBackground="var(--background)"
                className="size-5"
                iconClassName="size-4 text-foreground/80"
              />
              {label}
            </h2>
            <UsageLimitsAuthRecovery group={group} />
          </section>
        );
      })}

      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              <p className="text-xs break-words text-muted-foreground">
                {link.accounts.join(", ")}
              </p>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  <T>View usage in ChatGPT with your connected account.</T>
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            {gt("Manage usage")}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}

      {sourceNotices.length > 0 ? (
        <Alert variant="warning" controlAlignment="first-line">
          <AlertTriangleIcon />
          {sourceNotices.map((notice) => (
            <AlertTitle key={notice} className="break-words">
              {notice}
            </AlertTitle>
          ))}
        </Alert>
      ) : null}
    </div>
  );
}
