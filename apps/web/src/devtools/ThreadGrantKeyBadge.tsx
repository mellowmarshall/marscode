import type { EnvironmentId } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { KeyRoundIcon, XIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { m } from "~/i18n/messages";
import { InlineButton } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { fetchDevtoolsJson, type UnifiedActiveGrant } from "./devtoolsClient";
import { removeActiveGrant, useDevtoolsSelector } from "./devtoolsStore";

const EMPTY_GRANTS: ReadonlyArray<UnifiedActiveGrant> = [];

export function formatGrantRemaining(grant: UnifiedActiveGrant, nowMs: number): string {
  if (grant.kind === "guard_bundle") {
    return m(msg("Until PR merge or protected diff changes"));
  }
  const expMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expMs)) return m(msg("Active"));
  const remainingMs = Math.max(0, expMs - nowMs);
  if (remainingMs === 0) return m(msg("Expiring"));
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return m(msg("{hours}h {minutes}m left", { hours, minutes }));
  return m(msg("{minutes}m left", { minutes }));
}

export function formatGrantBriefSummary(grant: UnifiedActiveGrant): string {
  const raw = grant.summary.trim();
  if (raw.length > 0) {
    return raw.length > 72 ? `${raw.slice(0, 71)}…` : raw;
  }
  if (grant.kind === "secret_access") {
    return grant.delivery === "file" ? m(msg("Password / secret file")) : m(msg("Secret access"));
  }
  return `${grant.guard}: ${grant.gateIds.join(", ")}`;
}

export const ThreadGrantKeyBadge = memo(function ThreadGrantKeyBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}) {
  const gt = useGT();
  const envGrants = useDevtoolsSelector(
    (s) => s.activeGrantsByEnv.get(props.environmentId) ?? EMPTY_GRANTS,
  );
  const threadGrants = envGrants.filter((g) => g.threadId === props.threadId);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const hasTimedGrant = threadGrants.some((g) => g.kind === "secret_access");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 30s ticker keeps remaining-time tooltips fresh only while a timed grant exists
  useEffect(() => {
    if (!hasTimedGrant) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [hasTimedGrant]);

  if (threadGrants.length === 0) return null;

  const handleRevoke = (grantId: string) => {
    if (revokingId !== null) return;
    setRevokingId(grantId);
    void fetchDevtoolsJson<{ readonly ok?: boolean; readonly error?: string }>(
      props.environmentId,
      `/guards/grants/${encodeURIComponent(grantId)}/revoke`,
      { method: "POST" },
    )
      .then((res) => {
        if (res.ok) {
          removeActiveGrant(props.environmentId, grantId);
        } else {
          toastManager.add({
            type: "error",
            title: res.data?.error ?? res.error ?? gt("Could not revoke grant"),
          });
        }
      })
      .finally(() => {
        setRevokingId(null);
      });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            data-testid="thread-grant-key-badge"
            aria-label={gt(
              "{count, plural, one {1 active approval grant} other {{count} active approval grants}}",
              {
                count: threadGrants.length,
              },
            )}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-0.5 text-warning outline-none hover:text-warning/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <KeyRoundIcon aria-hidden className="size-3.5 shrink-0" />
        {threadGrants.length > 1 ? (
          <span className="font-mono text-3xs leading-none tabular-nums">
            {threadGrants.length}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        sideOffset={4}
        variant="glass"
        className="pointer-events-auto w-76 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2 py-0.5">
          {threadGrants.map((grant) => (
            <div key={grant.grantId} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground wrap-anywhere">
                  {formatGrantBriefSummary(grant)}
                </div>
                <div className="font-mono text-2xs text-muted-foreground">
                  {formatGrantRemaining(grant, nowMs)}
                </div>
              </div>
              <InlineButton
                tone="muted"
                disabled={revokingId === grant.grantId}
                aria-label={gt("Revoke grant")}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRevoke(grant.grantId);
                }}
              >
                <XIcon aria-hidden className="size-3" />
                {gt("Revoke")}
              </InlineButton>
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
