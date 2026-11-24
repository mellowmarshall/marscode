/** Dedicated `Reaper & Sweep` tab inside Fleet Console (storage scan, reaper actions, cleanup rules). */
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, useGT } from "gt-react";
import { BotIcon, FileSearchIcon, HardDriveIcon, PlayIcon } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  fetchDevtoolsJson,
  type ReaperCargoResult,
  type ReaperPolicyDocument,
  type ReaperStatus,
  type StorageReviewLaunchPayload,
  type StorageScanPayload,
} from "./devtoolsClient";
import { DevtoolsStateBanner } from "./DevtoolsStateBanner";
import { closeFleetConsole, type ConsoleActionFeedback } from "./devtoolsStore";
import { formatJobBytes } from "./jobs/jobTypes";
import {
  parseRuleDrafts,
  ReaperRulesEditor,
  toRuleDrafts,
  type RuleDraftItem,
} from "./ReaperRulesEditor";
import { ReaperStatusCards } from "./ReaperStatusCards";

interface ExecJsonEnvelope<T> {
  readonly ok?: boolean;
  readonly exitCode?: number;
  readonly data?: T | null;
  readonly error?: string;
}

function unwrapExecPayload<T extends object>(
  raw: unknown,
): { readonly ok: boolean; readonly data: T | null; readonly error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, data: null };
  }
  const obj = raw as Record<string, unknown>;
  if ("exitCode" in obj || ("ok" in obj && "data" in obj)) {
    const env = obj as ExecJsonEnvelope<T>;
    const ok = env.ok !== false;
    const inner =
      env.data && typeof env.data === "object" && !Array.isArray(env.data) ? env.data : null;
    return {
      ok,
      data: inner,
      ...(typeof env.error === "string" && env.error ? { error: env.error } : {}),
    };
  }
  return { ok: true, data: raw as T };
}

function sanitizeReviewHost(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned.slice(0, 64) || "local";
}

export function FleetReaperTab({
  environmentId,
  localHostName,
  selectedHostName = null,
  isSelectedHostLocal = true,
  mergedWorktreesCount,
  onFeedback,
}: {
  readonly environmentId: EnvironmentId;
  readonly localHostName: string;
  readonly selectedHostName?: string | null;
  readonly isSelectedHostLocal?: boolean;
  readonly mergedWorktreesCount: number;
  readonly onFeedback: (fb: ConsoleActionFeedback) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();

  const [scan, setScan] = useState<StorageScanPayload | null>(null);
  const [reaper, setReaper] = useState<ReaperStatus | null>(null);
  const [cargoDry, setCargoDry] = useState<ReaperCargoResult | null>(null);
  const [policyDoc, setPolicyDoc] = useState<ReaperPolicyDocument | null>(null);
  const [rulesDraft, setRulesDraft] = useState<RuleDraftItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const rulesDirtyRef = useRef(false);
  const policyLoadedRef = useRef(false);

  const parsedDrafts = parseRuleDrafts(rulesDraft);
  const rulesDirty =
    policyDoc !== null && JSON.stringify(policyDoc.rules) !== JSON.stringify(parsedDrafts.rules);

  const handleChangeRules = (updater: (prev: RuleDraftItem[]) => RuleDraftItem[]) => {
    rulesDirtyRef.current = true;
    setRulesDraft(updater);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads reaper status, storage scan, and cleanup policy on tab open or manual refresh
  useEffect(() => {
    const controller = new AbortController();
    const query = reloadTick > 0 ? { _r: String(reloadTick) } : undefined;
    void Promise.all([
      fetchDevtoolsJson<StorageScanPayload>(environmentId, "/storage/scan", {
        ...(query ? { query } : {}),
        signal: controller.signal,
      }),
      fetchDevtoolsJson<ExecJsonEnvelope<ReaperStatus> | ReaperStatus>(
        environmentId,
        "/reaper/status",
        {
          ...(query ? { query } : {}),
          signal: controller.signal,
        },
      ),
      fetchDevtoolsJson<ReaperPolicyDocument>(environmentId, "/reaper/policy", {
        ...(query ? { query } : {}),
        signal: controller.signal,
      }),
    ]).then(([scanRes, reaperRes, policyRes]) => {
      if (controller.signal.aborted) return;
      const errors: string[] = [];
      if (scanRes.ok && scanRes.data) {
        setScan(scanRes.data);
      } else if (!scanRes.ok && scanRes.error) {
        errors.push(`scan: ${scanRes.error}`);
      }

      if (reaperRes.ok && reaperRes.data) {
        const unwrapped = unwrapExecPayload<ReaperStatus>(reaperRes.data);
        if (unwrapped.ok && unwrapped.data) {
          setReaper(unwrapped.data);
        } else if (unwrapped.error) {
          errors.push(`reaper: ${unwrapped.error}`);
        }
      } else if (!reaperRes.ok && reaperRes.error) {
        errors.push(`reaper: ${reaperRes.error}`);
      }

      if (policyRes.ok && policyRes.data) {
        setPolicyDoc(policyRes.data);
        // Never overwrite unsaved user edits on background/post-action refresh.
        if (!policyLoadedRef.current || !rulesDirtyRef.current) {
          policyLoadedRef.current = true;
          setRulesDraft(
            toRuleDrafts(Array.isArray(policyRes.data.rules) ? policyRes.data.rules : []),
          );
        }
      } else if (!policyRes.ok && policyRes.error) {
        errors.push(`policy: ${policyRes.error}`);
      }

      setLoadError(errors.length > 0 ? errors.join(" · ") : null);
    });
    return () => controller.abort();
  }, [environmentId, reloadTick]);

  const localActionsDisabled = !isSelectedHostLocal;
  const reviewTargetHost =
    !isSelectedHostLocal && selectedHostName ? selectedHostName : localHostName;

  const handleSaveRules = async () => {
    if (!parsedDrafts.valid) return;
    setBusy("save-policy");
    onFeedback({ tone: "busy", text: gt("Saving cleanup rules…") });
    const res = await fetchDevtoolsJson<ReaperPolicyDocument & { readonly error?: string }>(
      environmentId,
      "/reaper/policy",
      { method: "POST", body: { rules: parsedDrafts.rules } },
    );
    setBusy(null);
    if (res.ok && res.data && !res.data.error) {
      policyLoadedRef.current = true;
      rulesDirtyRef.current = false;
      setPolicyDoc(res.data);
      setRulesDraft(toRuleDrafts(Array.isArray(res.data.rules) ? res.data.rules : []));
      onFeedback({ tone: "ok", text: gt("Cleanup policy saved") });
    } else {
      onFeedback({
        tone: "error",
        text: res.data?.error ?? res.error ?? gt("Failed to save cleanup rules"),
      });
    }
  };

  const handleCargoDryRun = async () => {
    setBusy("cargo-dry");
    onFeedback({ tone: "busy", text: gt("Running Cargo reap dry-run…") });
    const res = await fetchDevtoolsJson<ExecJsonEnvelope<ReaperCargoResult> | ReaperCargoResult>(
      environmentId,
      "/reaper/cargo-dry-run",
    );
    setBusy(null);
    const unwrapped = res.ok && res.data ? unwrapExecPayload<ReaperCargoResult>(res.data) : null;
    if (unwrapped?.ok && unwrapped.data) {
      setCargoDry(unwrapped.data);
      const freed = (unwrapped.data.removed_bytes ?? 0) + (unwrapped.data.incremental_bytes ?? 0);
      onFeedback({
        tone: "ok",
        text: gt("Dry-run: {bytes} reclaimable across {dirs} build dirs", {
          bytes: formatJobBytes(freed),
          dirs: unwrapped.data.build_dirs ?? 0,
        }),
      });
    } else {
      onFeedback({
        tone: "error",
        text: unwrapped?.error ?? res.error ?? gt("Cargo dry-run failed"),
      });
    }
  };

  const handleRunReaper = async (cargoOnly: boolean) => {
    setBusy(cargoOnly ? "reap-cargo" : "reap-all");
    onFeedback({
      tone: "busy",
      text: cargoOnly ? gt("Reaping stale Cargo targets…") : gt("Running full reaper pass…"),
    });
    const res = await fetchDevtoolsJson<ExecJsonEnvelope<unknown>>(environmentId, "/reaper/run", {
      method: "POST",
      body: { cargoOnly },
    });
    setBusy(null);
    if (res.ok && res.data?.ok !== false) {
      setReloadTick((t) => t + 1);
      onFeedback({
        tone: "ok",
        text: cargoOnly ? gt("Cargo targets reaped") : gt("Reaper pass completed"),
      });
    } else {
      onFeedback({
        tone: "error",
        text: res.data?.error ?? res.error ?? gt("Reaper run failed"),
      });
    }
  };

  const handleRefreshScan = async () => {
    setBusy("scan-refresh");
    onFeedback({ tone: "busy", text: gt("Refreshing storage scan…") });
    const res = await fetchDevtoolsJson<StorageScanPayload>(
      environmentId,
      "/storage/scan/refresh",
      { method: "POST", body: {} },
    );
    if (res.ok && res.data) {
      setScan(res.data);
      const statusRes = await fetchDevtoolsJson<ExecJsonEnvelope<ReaperStatus> | ReaperStatus>(
        environmentId,
        "/reaper/status",
      );
      if (statusRes.ok && statusRes.data) {
        const unwrapped = unwrapExecPayload<ReaperStatus>(statusRes.data);
        if (unwrapped.ok && unwrapped.data) setReaper(unwrapped.data);
      }
      onFeedback({ tone: "ok", text: gt("Storage scan refreshed") });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to refresh storage scan") });
    }
    setBusy(null);
  };

  const handleStartAgentReview = async () => {
    setBusy("agent-review");
    onFeedback({
      tone: "busy",
      text: gt("Launching storage cleanup review agent for {host}…", { host: reviewTargetHost }),
    });
    const res = await fetchDevtoolsJson<StorageReviewLaunchPayload>(
      environmentId,
      "/storage/review",
      { method: "POST", body: { host: sanitizeReviewHost(reviewTargetHost) } },
    );
    setBusy(null);
    if (res.ok && res.data?.launched && res.data.threadId) {
      onFeedback({ tone: "ok", text: gt("Opened agent cleanup review thread") });
      closeFleetConsole();
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: res.data.threadId },
      });
    } else if (res.ok && res.data?.prompt) {
      void navigator.clipboard?.writeText(res.data.prompt).catch(() => undefined);
      onFeedback({
        tone: "ok",
        text: gt("Copied cleanup review prompt to clipboard (no default provider ready)"),
      });
    } else {
      onFeedback({ tone: "error", text: res.error ?? gt("Failed to launch cleanup review") });
    }
  };

  const protectedRoots = Array.isArray(policyDoc?.protectedHistoryRoots)
    ? policyDoc.protectedHistoryRoots
    : [];

  return (
    <div className="space-y-4 p-4">
      {loadError ? (
        <DevtoolsStateBanner
          compact
          status={scan || reaper || policyDoc ? "degraded" : "error"}
          title={loadError}
          onRetry={() => setReloadTick((t) => t + 1)}
          retrying={busy !== null}
        />
      ) : null}

      {!isSelectedHostLocal ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <T>
            Reaper & policy edits run only on local host <Var>{localHostName}</Var>. Local actions
            are disabled while remote machine <Var>{selectedHostName ?? "remote"}</Var> is selected.
            Use Agent cleanup review to audit that remote machine.
          </T>
        </div>
      ) : null}

      {/* Top action strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <HardDriveIcon className="size-3.5 text-muted-foreground" />
            <T>
              Reaper & Sweep: <Var>{localHostName}</Var>
            </T>
            {scan?.hostScan?.high_pressure ? (
              <Badge size="sm" variant="error">
                <T>High disk pressure</T>
              </Badge>
            ) : null}
          </div>
          <p className="text-2xs text-muted-foreground">
            <T>
              Automated stale tmp/Cargo/worktree cleanup plus approved per-host cleanup rules.
              History paths are hard-protected.
            </T>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null || localActionsDisabled}
            onClick={() => void handleRefreshScan()}
          >
            <FileSearchIcon className="mr-1 size-3" />
            <T>Refresh scan</T>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null || localActionsDisabled}
            onClick={() => void handleCargoDryRun()}
          >
            <T>Cargo dry-run</T>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null || localActionsDisabled}
            onClick={() => void handleRunReaper(false)}
          >
            <PlayIcon className="mr-1 size-3" />
            <T>Run reaper</T>
          </Button>
          <Button size="xs" disabled={busy !== null} onClick={() => void handleStartAgentReview()}>
            <BotIcon className="mr-1 size-3" />
            <T>Agent cleanup review</T>
          </Button>
        </div>
      </div>

      <ReaperStatusCards
        scan={scan}
        reaper={reaper}
        cargoDry={cargoDry}
        mergedWorktreesCount={mergedWorktreesCount}
        onFeedback={onFeedback}
      />

      <ReaperRulesEditor
        policyPath={policyDoc?.policyPath ?? null}
        rulesDraft={rulesDraft}
        protectedRoots={protectedRoots}
        rulesDirty={rulesDirty}
        rulesValid={parsedDrafts.valid}
        readOnly={localActionsDisabled}
        busy={busy !== null}
        onChangeRules={handleChangeRules}
        onSave={() => void handleSaveRules()}
      />
    </div>
  );
}
