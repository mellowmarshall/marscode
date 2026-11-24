/** Host disk mount bars and live Reaper & Worktree Sweep summary cards inside `FleetReaperTab`. */
import { T, useGT } from "gt-react";
import { CopyIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import type { ReaperCargoResult, ReaperStatus, StorageScanPayload } from "./devtoolsClient";
import type { ConsoleActionFeedback } from "./devtoolsStore";
import { formatJobBytes } from "./jobs/jobTypes";

function ReaperMetricTile({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number;
}) {
  return (
    <div className="rounded border border-border/60 bg-background/60 p-2">
      <div className="text-3xs text-muted-foreground">{label}</div>
      <div className="font-mono font-medium text-foreground tabular-nums">{value}</div>
    </div>
  );
}

export function ReaperStatusCards({
  scan,
  reaper,
  cargoDry,
  mergedWorktreesCount,
  onFeedback,
}: {
  readonly scan: StorageScanPayload | null;
  readonly reaper: ReaperStatus | null;
  readonly cargoDry: ReaperCargoResult | null;
  readonly mergedWorktreesCount: number;
  readonly onFeedback: (fb: ConsoleActionFeedback) => void;
}) {
  const gt = useGT();
  const mounts = Array.isArray(scan?.hostScan?.mounts) ? scan.hostScan.mounts : [];
  const staleTmp = reaper?.stale_tmp;
  const protectedSummary = reaper?.protected;
  const cargoLastRun = reaper?.cargo_last_run?.last_run;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <section className="space-y-2.5 rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="flex items-center justify-between text-xs font-semibold">
          <T>Host Mounts</T>
          {scan?.hostScan?.scanned_at ? (
            <span className="font-mono text-3xs font-normal text-muted-foreground">
              {scan.hostScan.scanned_at}
            </span>
          ) : null}
        </div>
        {mounts.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            <T>No storage scan snapshot recorded yet. Click Refresh scan above.</T>
          </div>
        ) : (
          <div className="space-y-2">
            {mounts.map((m) => {
              const usedPct =
                typeof m.used_pct === "number" && Number.isFinite(m.used_pct) ? m.used_pct : 0;
              return (
                <div key={m.mount} className="space-y-1">
                  <div className="flex items-center justify-between font-mono text-2xs tabular-nums">
                    <span className="font-medium text-foreground">{m.mount}</span>
                    <span
                      className={
                        usedPct >= 95
                          ? "font-medium text-destructive-foreground"
                          : usedPct >= 80
                            ? "font-medium text-warning-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {gt("{pct}% · {free} free", {
                        pct: usedPct.toFixed(1),
                        free: formatJobBytes(m.avail_bytes),
                      })}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={
                        usedPct >= 95
                          ? "h-full rounded-full bg-destructive"
                          : usedPct >= 80
                            ? "h-full rounded-full bg-warning"
                            : "h-full rounded-full bg-muted-foreground/65"
                      }
                      style={{ width: `${Math.max(0, Math.min(100, usedPct))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2.5 rounded-lg border border-border/70 bg-card/40 p-3">
        <div className="flex items-center justify-between text-xs font-semibold">
          <T>Reaper & Worktree Sweep</T>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard
                ?.writeText("ship-queue sweep --dry-run")
                .catch(() => undefined);
              onFeedback({ tone: "ok", text: gt("Copied: ship-queue sweep --dry-run") });
            }}
          >
            <CopyIcon className="mr-1 size-3" />
            <T>Copy sweep</T>
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-2xs">
          <ReaperMetricTile
            label={gt("Stale tmp")}
            value={
              staleTmp
                ? gt("{dirs} dirs · {files} files", {
                    dirs: staleTmp.dirs ?? 0,
                    files: staleTmp.files ?? 0,
                  })
                : "-"
            }
          />
          <ReaperMetricTile
            label={gt("Protected active")}
            value={
              protectedSummary
                ? gt("{s} sessions · {w} worktrees", {
                    s: protectedSummary.sessions ?? 0,
                    w: protectedSummary.worktrees ?? 0,
                  })
                : "-"
            }
          />
          <ReaperMetricTile label={gt("Merged worktrees to sweep")} value={mergedWorktreesCount} />
          <ReaperMetricTile
            label={gt("Cargo reclaimable")}
            value={
              cargoDry
                ? formatJobBytes((cargoDry.removed_bytes ?? 0) + (cargoDry.incremental_bytes ?? 0))
                : cargoLastRun
                  ? gt("last run {ts}", { ts: cargoLastRun.slice(0, 10) })
                  : "-"
            }
          />
        </div>
      </section>
    </div>
  );
}
