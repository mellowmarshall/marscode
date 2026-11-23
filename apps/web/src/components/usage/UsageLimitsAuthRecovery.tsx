import type { LimitRecoveryGroup, LimitRecoveryTarget } from "@t3tools/shared/usageLimitsHealth";
import { AlertTriangleIcon, CheckIcon, RefreshCwIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { UsageLimitsAuthFlow } from "./UsageLimitsAuthFlow";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

export function UsageLimitsAuthRecovery({
  group,
  onRecovered,
}: {
  readonly group: LimitRecoveryGroup;
  readonly onRecovered?: () => void;
}) {
  const gt = useGT();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, COMMAND_OPTIONS);
  const [activeTargetKey, setActiveTargetKey] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [healedMessage, setHealedMessage] = useState<string | null>(null);

  const driverLabel = providerClients.get(group.driver)?.label ?? String(group.driver);
  const authTargets = group.targets.filter((t) => t.reason === "unauthenticated");
  const primarySignInTarget =
    authTargets.find((t) => t.canAuthenticate) ??
    group.targets.find((t) => t.canAuthenticate) ??
    null;
  const targetKey = (t: LimitRecoveryTarget) => `${t.environmentId}:${t.instanceId}`;
  const activeTarget = group.targets.find((t) => targetKey(t) === activeTargetKey) ?? null;
  const signingPrimary =
    primarySignInTarget !== null &&
    activeTarget !== null &&
    targetKey(activeTarget) === targetKey(primarySignInTarget);

  async function retryAll() {
    if (retrying) return;
    setRetrying(true);
    setHealedMessage(null);
    const uniqueEnvs = [...new Set(group.targets.map((t) => t.environmentId))];
    try {
      await Promise.allSettled(
        uniqueEnvs.map((environmentId) => refreshProviders({ environmentId, input: {} })),
      );
      onRecovered?.();
    } catch {
      // Errors surface individually through the provider status snapshots.
    }
    setRetrying(false);
  }

  const title =
    authTargets.length > 0
      ? authTargets.length === 1
        ? gt("{provider} needs sign-in on {environment}", {
            provider: driverLabel,
            environment: authTargets[0]!.environmentLabel,
          })
        : gt("{count} environments need {provider} sign-in", {
            count: authTargets.length,
            provider: driverLabel,
          })
      : group.targets.length === 1
        ? gt("Could not read {provider} limits on {environment}", {
            provider: driverLabel,
            environment: group.targets[0]!.environmentLabel,
          })
        : gt("Could not read {provider} limits on {count} environments", {
            provider: driverLabel,
            count: group.targets.length,
          });

  const subtitle =
    authTargets.length > 0
      ? gt("Sign in inside T3 Code to restore limits without leaving the app.")
      : group.targets[0]!.message;

  return (
    <div className="flex flex-col rounded-md border border-warning/30 bg-warning-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <AlertTriangleIcon className="size-3.5 shrink-0 text-warning-foreground" aria-hidden />
            <span>{title}</span>
          </div>
          <p className="text-2xs text-muted-foreground">{healedMessage ?? subtitle}</p>
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {group.targets.map((target) => {
              const key = targetKey(target);
              const selected = activeTargetKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!target.canAuthenticate}
                  aria-pressed={selected}
                  onClick={() => setActiveTargetKey(selected ? null : key)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-2xs transition-colors",
                    target.canAuthenticate
                      ? "cursor-pointer hover:bg-background"
                      : "cursor-default opacity-60",
                    selected
                      ? "border-ring bg-background text-foreground"
                      : "border-border/80 bg-background/70 text-foreground",
                  )}
                >
                  {target.environmentLabel}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={retrying} onClick={() => void retryAll()}>
            <RefreshCwIcon className={retrying ? "size-3 animate-spin" : "size-3"} aria-hidden />
            <T>Retry</T>
          </Button>
          {primarySignInTarget ? (
            <Button
              size="xs"
              variant="default"
              onClick={() => setActiveTargetKey(targetKey(primarySignInTarget))}
            >
              {signingPrimary ? (
                <>
                  <CheckIcon className="size-3" aria-hidden />
                  <T>Signing in…</T>
                </>
              ) : (
                <T>Sign in in T3</T>
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {activeTarget ? (
        <UsageLimitsAuthFlow
          key={targetKey(activeTarget)}
          target={activeTarget}
          onFinished={() => {
            setHealedMessage(
              gt("Signed in on {environment}.", { environment: activeTarget.environmentLabel }),
            );
            setActiveTargetKey(null);
            onRecovered?.();
          }}
          onClose={() => setActiveTargetKey(null)}
        />
      ) : null}
    </div>
  );
}
