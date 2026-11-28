/**
 * Review & Ship stats table: one collapsed row per model, effort rows on demand.
 * Severity columns appear only when the container has room, so it never scrolls sideways.
 */
import { Fragment, useId, useState } from "react";
import { T, useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";
import type { ReviewStatsGroupRow, ReviewStatsPayload, ReviewStatsSide } from "./devtoolsClient";
import { groupRowsByModelAndEffort } from "./usageReviewsMerge";

type SeverityMetricRow = Pick<
  ReviewStatsGroupRow,
  | "reviews"
  | "passRatePct"
  | "avgIssues"
  | "challenges"
  | "overrides"
  | "breaking"
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "total"
>;

const NUM = "w-px whitespace-nowrap px-2 text-right";
const AVG_COL = "hidden @md/reviews:table-cell";
const SEV_COL = "hidden @xl/reviews:table-cell";
const BODY = "font-mono tabular-nums";

function SeverityRowCells({
  row,
  sub,
}: {
  readonly row: SeverityMetricRow;
  readonly sub?: boolean;
}) {
  const pad = sub ? "py-1.5" : "py-2";
  const tone = sub ? "text-muted-foreground" : "";
  return (
    <>
      <td className={cn(NUM, pad, tone)}>{row.reviews}</td>
      <td className={cn(NUM, pad, tone)}>{`${row.passRatePct.toFixed(0)}%`}</td>
      <td className={cn(NUM, pad, tone, AVG_COL)}>{row.avgIssues.toFixed(2)}</td>
      <td className={cn(NUM, pad, tone, AVG_COL)}>
        {row.challenges ? `${row.overrides ?? 0}/${row.challenges}` : "·"}
      </td>
      <td className={cn(NUM, pad, SEV_COL, "text-destructive")}>{row.breaking || "·"}</td>
      <td className={cn(NUM, pad, SEV_COL, "text-destructive")}>{row.critical || "·"}</td>
      <td className={cn(NUM, pad, SEV_COL, "text-warning")}>{row.high || "·"}</td>
      <td className={cn(NUM, pad, SEV_COL)}>{row.medium || "·"}</td>
      <td className={cn(NUM, pad, SEV_COL, "text-muted-foreground")}>{row.low || "·"}</td>
      <td className={cn(NUM, pad, "pr-3", sub ? tone : "font-semibold")}>{row.total}</td>
    </>
  );
}

export function UsageReviewsTable({
  stats,
  side,
  loading,
}: {
  readonly stats: ReviewStatsPayload | null;
  readonly side: ReviewStatsSide;
  readonly loading: boolean;
}) {
  const gt = useGT();
  const idPrefix = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const groupedModels = stats && side !== "pair" ? groupRowsByModelAndEffort(stats.groups) : [];
  const rowCount = side === "pair" ? (stats?.groups.length ?? 0) : groupedModels.length;

  const toggle = (model: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });

  return (
    <section className="@container/reviews overflow-hidden rounded-lg border border-border/70 bg-card/40">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/60 bg-muted/20 px-3 py-2 text-xs font-semibold">
        <T>Review & Ship Stats (grouped by model & effort)</T>
        <span className="font-mono text-3xs font-normal text-muted-foreground">
          {loading
            ? gt("Loading…")
            : side === "pair"
              ? gt("{n} rows", { n: rowCount })
              : gt("{count, plural, one {{count} model} other {{count} models}}", {
                  count: rowCount,
                })}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border/60 bg-muted/15 text-left font-mono text-3xs uppercase text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">
                {side === "pair" ? gt("Pair") : gt("Model")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium")}>
                {gt("Rev")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium")}>
                {gt("Pass%")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium", AVG_COL)}>
                {gt("Avg")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium", AVG_COL)}>
                {gt("Ovr")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium", SEV_COL)}>
                {gt("Brk")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium", SEV_COL)}>
                {gt("Crit")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium", SEV_COL)}>
                {gt("High")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium", SEV_COL)}>
                {gt("Med")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 font-medium", SEV_COL)}>
                {gt("Low")}
              </th>
              <th scope="col" className={cn(NUM, "py-2 pr-3 font-medium")}>
                {gt("Total")}
              </th>
            </tr>
          </thead>
          {!stats || stats.groups.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-muted-foreground">
                  <T>No review records match the selected filters.</T>
                </td>
              </tr>
            </tbody>
          ) : side === "pair" ? (
            <tbody className={BODY}>
              {stats.groups.map((row) => (
                <tr key={row.key} className="hover:bg-muted/20">
                  <td className="px-3 py-2 font-sans font-medium text-foreground wrap-anywhere">
                    {row.key}
                  </td>
                  <SeverityRowCells row={row} />
                </tr>
              ))}
            </tbody>
          ) : (
            groupedModels.map((grp, index) => {
              const open = expanded.has(grp.model);
              const effortsId = `${idPrefix}-efforts-${index}`;
              const passRatePct = grp.reviews > 0 ? (100 * grp.passed) / grp.reviews : 0;
              const avgIssues = grp.reviews > 0 ? grp.total / grp.reviews : 0;
              return (
                <Fragment key={grp.model}>
                  <tbody className={cn(BODY, "border-t border-border/50")}>
                    <tr className="hover:bg-muted/20">
                      <td className="px-1.5 py-1 font-sans">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={effortsId}
                          className="flex w-full min-w-0 cursor-pointer items-start gap-1 rounded px-1.5 py-1 text-left font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                          onClick={() => toggle(grp.model)}
                        >
                          <ChevronRightIcon
                            aria-hidden
                            className={cn(
                              "mt-px size-3.5 shrink-0 text-muted-foreground",
                              open && "rotate-90",
                            )}
                          />
                          <span className="min-w-0 wrap-anywhere">{grp.model}</span>
                        </button>
                        {open && grp.family ? (
                          <div className="pb-1 pl-6 font-mono text-3xs text-muted-foreground">
                            {grp.family}
                          </div>
                        ) : null}
                      </td>
                      <SeverityRowCells row={{ ...grp, passRatePct, avgIssues }} />
                    </tr>
                  </tbody>
                  <tbody id={effortsId} hidden={!open} className={BODY}>
                    {grp.efforts.map((eff) => (
                      <tr key={eff.effort} className="border-t border-border/50 bg-muted/10">
                        <td className="py-1.5 pr-3 pl-8 font-sans text-2xs text-muted-foreground">
                          <Badge size="sm" variant="outline">
                            {eff.effort && eff.effort !== "default"
                              ? eff.effort
                              : gt("default", { $context: "reasoning effort not set" })}
                          </Badge>
                        </td>
                        <SeverityRowCells row={eff} sub />
                      </tr>
                    ))}
                  </tbody>
                </Fragment>
              );
            })
          )}
        </table>
      </div>
    </section>
  );
}
