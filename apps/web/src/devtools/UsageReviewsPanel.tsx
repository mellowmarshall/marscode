/**
 * Review + Ship stats and Cerno findings panel mounted inside T3's Usage page (`Cost | Tokens | Limits | Reviews`).
 * Queries connected environments in parallel and merges multi-host data; UsageReviewsTable shows it.
 */
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, Var, useGT } from "gt-react";
import { AwardIcon, BugIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  fetchDevtoolsJson,
  type CernoStatsPayload,
  type ReviewStatsPayload,
  type ReviewStatsSide,
} from "./devtoolsClient";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import { DevtoolsStateBanner } from "./DevtoolsStateBanner";
import { readCachedCapabilities } from "./devtoolsStreams";
import { UsageCernoSection } from "./UsageCernoSection";
import { mergeCernoStatsPayloads, mergeReviewStatsPayloads } from "./usageReviewsMerge";
import { UsageReviewsTable } from "./UsageReviewsTable";

function UsageReviewsPanelInner({
  environmentIds,
  windowDays,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly windowDays: number;
}) {
  const gt = useGT();
  const envKey = environmentIds.join("\0");
  const [side, setSide] = useState<ReviewStatsSide>("reviewer");
  const [source, setSource] = useState<"all" | "playbook_challenge" | "ship_queue_review">("all");
  const [machine, setMachine] = useState<string>("all");
  const [family, setFamily] = useState<string>("all");
  const [reloadTick, setReloadTick] = useState(0);
  const lastManualRefreshTickRef = useRef(0);
  const requestKey = `${envKey}|${side}|${source}|${machine}|${family}|${windowDays}|${reloadTick}`;
  const [loadedRequestKey, setLoadedRequestKey] = useState<string | null>(null);
  const [stats, setStats] = useState<ReviewStatsPayload | null>(null);
  const [cerno, setCerno] = useState<CernoStatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = environmentIds.length > 0 && loadedRequestKey !== requestKey;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- queries all candidate environments in parallel, merges responding hosts, and skips unpatched/unavailable hosts
  useEffect(() => {
    const rawCandidates = envKey ? (envKey.split("\0") as EnvironmentId[]) : [];
    if (rawCandidates.length === 0) return;
    // Skip environments already known to lack Devtools API (cached 404) when other candidates exist.
    const filtered = rawCandidates.filter((id) => readCachedCapabilities(id)?.unsupported !== true);
    const candidates = filtered.length > 0 ? filtered : rawCandidates;

    const isManualRefresh = reloadTick !== lastManualRefreshTickRef.current;
    lastManualRefreshTickRef.current = reloadTick;

    const controller = new AbortController();
    const reviewQuery: Record<string, string> = {
      side,
      by: "model",
      source,
      days: String(windowDays),
      ...(machine !== "all" ? { host: machine } : {}),
      ...(family !== "all" ? { family } : {}),
      ...(isManualRefresh ? { refresh: "1", _r: String(reloadTick) } : {}),
    };
    const cernoQuery: Record<string, string> = {
      days: String(windowDays),
      ...(machine !== "all" ? { host: machine } : {}),
    };

    void Promise.all(
      candidates.map(async (envId) => {
        const [revRes, cernoRes] = await Promise.all([
          fetchDevtoolsJson<ReviewStatsPayload>(envId, "/review-stats", {
            query: reviewQuery,
            signal: controller.signal,
          }),
          fetchDevtoolsJson<CernoStatsPayload>(envId, "/stats/cerno", {
            query: cernoQuery,
            signal: controller.signal,
          }),
        ]);
        return { envId, revRes, cernoRes };
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const okReviews: ReviewStatsPayload[] = [];
      const okCerno: CernoStatsPayload[] = [];
      let firstError: string | null = null;
      for (const { revRes, cernoRes } of results) {
        if (revRes.ok && revRes.data) {
          okReviews.push(revRes.data);
        } else if (firstError === null && revRes.error) {
          firstError = revRes.error;
        }
        if (cernoRes.ok && cernoRes.data) {
          okCerno.push(cernoRes.data);
        }
      }
      setLoadedRequestKey(requestKey);
      if (okReviews.length > 0) {
        setStats(mergeReviewStatsPayloads(okReviews));
        setCerno(mergeCernoStatsPayloads(okCerno));
        setError(null);
      } else {
        setStats(null);
        setCerno(mergeCernoStatsPayloads(okCerno));
        setError(firstError ?? "");
      }
    });
    return () => controller.abort();
  }, [envKey, side, source, machine, family, windowDays, reloadTick, requestKey]);

  if (environmentIds.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground">
        <T>Connect an environment to see review and Cerno statistics.</T>
      </div>
    );
  }

  const machineOptions = Array.from(
    new Set([...(stats?.facets.hosts ?? []), ...(cerno?.facets.hosts ?? [])]),
  )
    .filter(Boolean)
    .toSorted();

  const familyOptions = stats?.facets.families ?? [];
  const totals = stats?.totals ?? null;

  return (
    <div className="@container/reviews-panel space-y-6">
      {/* Filter Controls: Machine + Model Family dropdowns + Side + Source */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 p-0.5 text-xs">
            {(
              [
                ["reviewer", gt("Reviewer")],
                ["submitter", gt("Submitter")],
                ["pair", gt("Submitter → Reviewer")],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={
                  side === val
                    ? "rounded bg-background px-2 py-1 font-medium text-foreground shadow-xs"
                    : "rounded px-2 py-1 text-muted-foreground hover:text-foreground"
                }
                onClick={() => setSide(val)}
              >
                {label}
              </button>
            ))}
          </div>

          <Select value={machine} onValueChange={(v) => v && setMachine(v)}>
            <SelectTrigger
              size="sm"
              className="w-auto min-w-40"
              aria-label={gt("Filter by machine")}
            >
              <SelectValue>{machine === "all" ? gt("All machines") : machine}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start">
              <SelectItem value="all">{gt("All machines")}</SelectItem>
              {machineOptions.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>

          <Select value={family} onValueChange={(v) => v && setFamily(v)}>
            <SelectTrigger
              size="sm"
              className="w-auto min-w-48"
              aria-label={gt("Filter by model family")}
            >
              <SelectValue>{family === "all" ? gt("All model families") : family}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start">
              <SelectItem value="all">{gt("All model families")}</SelectItem>
              {familyOptions.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>

          <Select
            value={source}
            onValueChange={(v) => {
              if (v === "all" || v === "playbook_challenge" || v === "ship_queue_review") {
                setSource(v);
              }
            }}
          >
            <SelectTrigger size="sm" className="w-40" aria-label={gt("Filter by source")}>
              <SelectValue>
                {source === "all"
                  ? gt("Review + Ship")
                  : source === "ship_queue_review"
                    ? gt("Adversarial Review")
                    : gt("Playbook Challenge")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start">
              <SelectItem value="all">{gt("Review + Ship")}</SelectItem>
              <SelectItem value="ship_queue_review">{gt("Adversarial Review")}</SelectItem>
              <SelectItem value="playbook_challenge">{gt("Playbook Challenge")}</SelectItem>
            </SelectPopup>
          </Select>
        </div>

        <Button
          size="xs"
          variant="outline"
          disabled={loading}
          onClick={() => setReloadTick((t) => t + 1)}
        >
          <RefreshCwIcon className={`mr-1 size-3${loading ? " animate-spin" : ""}`} />
          <T>Refresh</T>
        </Button>
      </div>

      {error !== null ? (
        <DevtoolsStateBanner
          compact
          status={stats || cerno ? "degraded" : "error"}
          title={error || gt("Failed to load review statistics")}
          onRetry={() => setReloadTick((t) => t + 1)}
          retrying={loading}
        />
      ) : null}

      {/* Top KPI Summary Cards */}
      {totals ? (
        <div className="grid grid-cols-1 gap-3 @sm/reviews-panel:grid-cols-2 @3xl/reviews-panel:grid-cols-4">
          <div className="rounded-lg border border-border/70 bg-card/40 p-3">
            <div className="text-2xs text-muted-foreground">
              {windowDays === 0 ? (
                <T>Reviews (All)</T>
              ) : (
                <T>
                  Reviews (<Var>{windowDays}</Var>d)
                </T>
              )}
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
              {totals.reviews}
            </div>
            <div className="text-2xs text-muted-foreground tabular-nums">
              <T>
                <Var>{totals.passRatePct.toFixed(1)}</Var>% pass · <Var>{totals.flagged}</Var>{" "}
                flagged
              </T>
            </div>
          </div>

          <div className="rounded-lg border border-border/70 bg-card/40 p-3">
            <div className="text-2xs text-muted-foreground">
              <T>Findings</T>
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{totals.total}</div>
            <div className="font-mono text-3xs text-muted-foreground tabular-nums">
              {`B:${totals.breaking} C:${totals.critical} H:${totals.high} M:${totals.medium} L:${totals.low}`}
            </div>
          </div>

          <div className="rounded-lg border border-border/70 bg-card/40 p-3">
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <BugIcon className="size-3.5 text-destructive" />
              <T>Top bug submitter</T>
            </div>
            {stats?.highlights.topBugSubmitter ? (
              <>
                <div className="mt-1 text-sm font-semibold wrap-anywhere">
                  {stats.highlights.topBugSubmitter.label}
                </div>
                <div className="font-mono text-3xs text-muted-foreground tabular-nums">
                  {gt("{issues} issues ({avg}/rev)", {
                    issues: stats.highlights.topBugSubmitter.totalIssues,
                    avg: stats.highlights.topBugSubmitter.avgIssues,
                  })}
                </div>
              </>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">-</div>
            )}
          </div>

          <div className="rounded-lg border border-border/70 bg-card/40 p-3">
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <AwardIcon className="size-3.5 text-success" />
              <T>Top bug catcher</T>
            </div>
            {stats?.highlights.topBugCatcher ? (
              <>
                <div className="mt-1 text-sm font-semibold wrap-anywhere">
                  {stats.highlights.topBugCatcher.label}
                </div>
                <div className="font-mono text-3xs text-muted-foreground tabular-nums">
                  {gt("{issues} caught ({avg}/rev)", {
                    issues: stats.highlights.topBugCatcher.totalIssues,
                    avg: stats.highlights.topBugCatcher.avgIssues,
                  })}
                </div>
              </>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">-</div>
            )}
          </div>
        </div>
      ) : null}

      <UsageReviewsTable stats={stats} side={side} loading={loading} />

      {cerno?.enabled ? <UsageCernoSection cerno={cerno} /> : null}
    </div>
  );
}

export function UsageReviewsPanel(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly windowDays: number;
}) {
  return (
    <DevtoolsErrorBoundary
      panelName="Review & Ship Stats"
      resetKeys={[props.environmentIds.join("\0"), props.windowDays]}
    >
      <UsageReviewsPanelInner {...props} />
    </DevtoolsErrorBoundary>
  );
}
