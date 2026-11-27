import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { KeyRoundIcon, RefreshCwIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react";

import { m } from "~/i18n/messages";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { usePrimaryEnvironmentId } from "../state/environments";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import {
  DEFAULT_GUARD_NOTIFICATION_MODE,
  useGuardNotificationMode,
  type GuardNotificationMode,
} from "./devtoolsPreferences";
import { fetchDevtoolsJson, type UnifiedActiveGrant } from "./devtoolsClient";
import { removeActiveGrant, setActiveGrantsForEnv, useDevtoolsSelector } from "./devtoolsStore";
import { formatGrantBriefSummary, formatGrantRemaining } from "./ThreadGrantKeyBadge";

interface GuardAuditEntry {
  readonly ts?: string;
  readonly eventType?: string;
  readonly guard?: string;
  readonly scope?: string;
  readonly summary?: string;
  readonly reason?: string;
  readonly thread_id?: string;
  readonly command?: ReadonlyArray<string>;
}

interface GuardExceptionsPayload {
  readonly path: string | null;
  readonly entries: unknown;
  readonly waivers?: ReadonlyArray<{
    readonly repo: string;
    readonly scope: string;
    readonly reason: string;
  }>;
}

const EMPTY_GRANTS: ReadonlyArray<UnifiedActiveGrant> = [];

const GUARD_ALERT_LABELS: Record<GuardNotificationMode, string> = {
  follow: msg("Follow T3 notifications (default)"),
  always: msg("Always alert (sound + desktop)"),
  silent: msg("Desktop only (silent)"),
  off: msg("Off (modal only)"),
};

async function fetchSecurityData(envId: EnvironmentId) {
  const [grantsRes, auditRes, excRes] = await Promise.all([
    fetchDevtoolsJson<{ readonly grants?: ReadonlyArray<UnifiedActiveGrant> }>(
      envId,
      "/guards/grants",
    ),
    fetchDevtoolsJson<{ readonly entries?: ReadonlyArray<GuardAuditEntry> }>(
      envId,
      "/guards/audit?limit=40",
    ),
    fetchDevtoolsJson<GuardExceptionsPayload>(envId, "/guards/exceptions"),
  ]);
  return { grantsRes, auditRes, excRes };
}

function SecuritySettingsPanelInner() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const environmentId = usePrimaryEnvironmentId();
  const [guardAlerts, setGuardAlerts] = useGuardNotificationMode();
  const activeGrants = useDevtoolsSelector((s) =>
    environmentId ? (s.activeGrantsByEnv.get(environmentId) ?? EMPTY_GRANTS) : EMPTY_GRANTS,
  );
  const [auditEntries, setAuditEntries] = useState<ReadonlyArray<GuardAuditEntry>>([]);
  const [exceptions, setExceptions] = useState<GuardExceptionsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refreshAll = (envId: EnvironmentId) => {
    setLoading(true);
    void fetchSecurityData(envId)
      .then(({ grantsRes, auditRes, excRes }) => {
        if (grantsRes.ok && Array.isArray(grantsRes.data?.grants)) {
          setActiveGrantsForEnv(envId, grantsRes.data.grants);
        }
        if (auditRes.ok && Array.isArray(auditRes.data?.entries)) {
          setAuditEntries(auditRes.data.entries);
        }
        if (excRes.ok && excRes.data) {
          setExceptions(excRes.data);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads active grants, audit log, and exceptions when environment changes
  useEffect(() => {
    if (!environmentId) return;
    let cancelled = false;
    void fetchSecurityData(environmentId).then(({ grantsRes, auditRes, excRes }) => {
      if (cancelled) return;
      if (grantsRes.ok && Array.isArray(grantsRes.data?.grants)) {
        setActiveGrantsForEnv(environmentId, grantsRes.data.grants);
      }
      if (auditRes.ok && Array.isArray(auditRes.data?.entries)) {
        setAuditEntries(auditRes.data.entries);
      }
      if (excRes.ok && excRes.data) {
        setExceptions(excRes.data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes remaining-time labels every 30s
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const handleRevoke = (grantId: string) => {
    if (!environmentId || revokingId !== null) return;
    setRevokingId(grantId);
    void fetchDevtoolsJson<{ readonly ok?: boolean; readonly error?: string }>(
      environmentId,
      `/guards/grants/${encodeURIComponent(grantId)}/revoke`,
      { method: "POST" },
    )
      .then((res) => {
        if (res.ok) {
          removeActiveGrant(environmentId, grantId);
          toastManager.add({ type: "success", title: gt("Grant revoked") });
          refreshAll(environmentId);
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
    <SettingsPageContainer>
      <SettingsSection
        id="security-active-grants"
        title={gt("Active approvals & password access")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!environmentId || loading}
            onClick={() => {
              if (environmentId) refreshAll(environmentId);
            }}
          >
            <RefreshCwIcon className="size-3.5" />
            {gt("Refresh")}
          </Button>
        }
      >
        <div className="space-y-3 p-3 sm:p-4">
          <p className="text-xs text-muted-foreground">
            {gt(
              "All live T3 approvals on this environment: bundled protected-diff guard grants and 24-hour password or secret access.",
            )}
          </p>
          {activeGrants.length === 0 ? (
            <p className="rounded-lg border border-border/60 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
              {gt("No active approval grants or 24-hour secret access on this environment.")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {activeGrants.map((grant) => (
                <div
                  key={grant.grantId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <KeyRoundIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground wrap-anywhere">
                          {formatGrantBriefSummary(grant)}
                        </span>
                        <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                          {grant.kind === "secret_access" ? gt("24h Secret") : gt("Protected Diff")}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs text-muted-foreground">
                        <span>{formatGrantRemaining(grant, nowMs)}</span>
                        {grant.kind === "guard_bundle" ? (
                          <span>
                            {grant.repo} · {grant.branch}
                            {grant.useCount > 0
                              ? ` · ${gt("{count}× used", { count: grant.useCount })}`
                              : ""}
                          </span>
                        ) : null}
                        {grant.threadId ? <span>thread: {grant.threadId.slice(0, 12)}</span> : null}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={revokingId === grant.grantId}
                    onClick={() => handleRevoke(grant.grantId)}
                  >
                    <Trash2Icon className="size-3.5" />
                    {gt("Revoke")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection id="security-host-guards" title={gt("Host-guard alerts")}>
        <SettingsRow
          {...searchableSetting("security-guard-alerts")}
          description={gt(
            "Control desktop notifications and sounds when an agent requests a host-guard override.",
          )}
          resetAction={
            guardAlerts !== DEFAULT_GUARD_NOTIFICATION_MODE ? (
              <SettingResetButton
                ariaLabel={gt("Reset guard alerts to default")}
                onClick={() => setGuardAlerts(DEFAULT_GUARD_NOTIFICATION_MODE)}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-56">
              <Select
                value={guardAlerts}
                onValueChange={(v) => {
                  if (v === "follow" || v === "always" || v === "silent" || v === "off") {
                    setGuardAlerts(v);
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full" aria-label={gt("Guard alerts")}>
                  <SelectValue>{m(GUARD_ALERT_LABELS[guardAlerts])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {(Object.keys(GUARD_ALERT_LABELS) as GuardNotificationMode[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {m(GUARD_ALERT_LABELS[k])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection id="security-audit-log" title={gt("Approval & override audit log")}>
        <div className="space-y-2.5 p-3 sm:p-4">
          <p className="text-xs text-muted-foreground">
            {gt("Recent approval prompts, decisions, expirations, disconnects, and revocations.")}
          </p>
          {auditEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {gt("No recent audit events recorded.")}
            </p>
          ) : (
            <div className="flex max-h-80 flex-col gap-1.5 overflow-auto pr-1">
              {auditEntries.map((entry) => (
                <div
                  key={`${entry.ts ?? ""}|${entry.eventType ?? ""}|${entry.guard ?? ""}|${entry.thread_id ?? ""}|${entry.summary ?? entry.reason ?? ""}|${entry.command?.join(" ") ?? ""}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border/60 bg-muted/15 px-3 py-2 text-xs"
                >
                  <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-2">
                    <span className="font-mono font-semibold text-foreground">
                      {entry.eventType ?? "override"}
                    </span>
                    <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                      {entry.guard ?? "guard"}
                    </span>
                    <span className="text-foreground/90 wrap-anywhere">
                      {entry.summary || entry.reason || entry.command?.join(" ") || ""}
                    </span>
                  </div>
                  {entry.ts ? (
                    <span className="font-mono text-2xs text-muted-foreground">{entry.ts}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection id="security-exceptions" title={gt("Policy exceptions")}>
        <div className="space-y-2.5 p-3 sm:p-4">
          <p className="text-xs text-muted-foreground">
            {exceptions?.path
              ? gt("Loaded from {path}", { path: exceptions.path })
              : gt("No exceptions.json file found on this host.")}
          </p>
          {exceptions?.entries ? (
            <pre className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-muted/20 p-3 font-mono text-xs text-foreground">
              {JSON.stringify(exceptions.entries, null, 2)}
            </pre>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldAlertIcon className="size-4" />
              <span>{gt("No exceptions configured.")}</span>
            </div>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function SecuritySettingsPanel() {
  const primaryEnvId = usePrimaryEnvironmentId();
  return (
    <DevtoolsErrorBoundary panelName="Security Settings">
      <SecuritySettingsPanelInner key={primaryEnvId ?? "__none__"} />
    </DevtoolsErrorBoundary>
  );
}
