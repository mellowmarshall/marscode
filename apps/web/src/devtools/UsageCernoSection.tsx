/** Cerno stream-sifting findings section rendered inside Usage -> Reviews when Cerno is enabled. */
import { T, useGT } from "gt-react";
import { ActivityIcon, ShieldAlertIcon } from "lucide-react";

import { Badge } from "../components/ui/badge";
import type { CernoStatsPayload } from "./devtoolsClient";
import { formatJobBytes } from "./jobs/jobTypes";

export function UsageCernoSection({ cerno }: { readonly cerno: CernoStatsPayload }) {
  const gt = useGT();
  if (!cerno.enabled) return null;

  return (
    <section className="space-y-3 rounded-lg border border-border/70 bg-card/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <ActivityIcon className="size-3.5 text-info-foreground" />
          <T>Cerno Stream Findings</T>
          <Badge size="sm" variant="secondary">
            {cerno.host}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-2xs text-muted-foreground tabular-nums">
          <span>{gt("{n} captures", { n: cerno.totals.captures })}</span>
          <span className="text-warning">{gt("{n} alerts", { n: cerno.totals.alerts })}</span>
          <span className="text-destructive">
            {gt("{n} disagreements", { n: cerno.totals.disagreements })}
          </span>
          <span>{formatJobBytes(cerno.totals.streamBytes)}</span>
        </div>
      </div>

      {cerno.byHarness.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/15 text-left font-mono text-3xs uppercase text-muted-foreground">
                <th className="px-3 py-1.5">{gt("Harness")}</th>
                <th className="px-2 py-1.5 text-right">{gt("Captures")}</th>
                <th className="px-2 py-1.5 text-right">{gt("Pass")}</th>
                <th className="px-2 py-1.5 text-right">{gt("Fail")}</th>
                <th className="px-2 py-1.5 text-right">{gt("Alerts")}</th>
                <th className="px-2 py-1.5 text-right">{gt("Disagree")}</th>
                <th className="px-3 py-1.5 text-right">{gt("Bytes")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50 font-mono tabular-nums">
              {cerno.byHarness.map((row) => (
                <tr key={row.key} className="hover:bg-muted/20">
                  <td className="px-3 py-1.5 font-sans font-medium">{row.key}</td>
                  <td className="px-2 py-1.5 text-right">{row.captures}</td>
                  <td className="px-2 py-1.5 text-right text-success">{row.pass}</td>
                  <td className="px-2 py-1.5 text-right text-destructive">{row.fail}</td>
                  <td className="px-2 py-1.5 text-right text-warning">{row.alerts}</td>
                  <td className="px-2 py-1.5 text-right text-destructive">{row.disagreements}</td>
                  <td className="px-3 py-1.5 text-right text-muted-foreground">
                    {formatJobBytes(row.streamBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {cerno.recentFindings.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
            <ShieldAlertIcon className="size-3" />
            <T>Recent Alerts & Disagreements</T>
          </div>
          <div className="divide-y divide-border/50 rounded-md border border-border/60 bg-background/50">
            {cerno.recentFindings.slice(0, 10).map((f) => (
              <div
                key={f.sourceId}
                className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 font-mono text-3xs"
              >
                <div className="flex items-center gap-2">
                  <Badge size="sm" variant={f.finalOutcome === "FAIL" ? "error" : "outline"}>
                    {f.finalOutcome}
                  </Badge>
                  <span className="text-foreground">{f.harness}</span>
                  <span className="text-muted-foreground">{f.mode}</span>
                  {f.disagreement ? (
                    <Badge size="sm" variant="warning">
                      {gt("disagreed ({raw})", { raw: f.rawOutcome })}
                    </Badge>
                  ) : null}
                  {f.alerts > 0 ? (
                    <span className="text-warning">{gt("{n} alerts", { n: f.alerts })}</span>
                  ) : null}
                </div>
                <span className="text-muted-foreground tabular-nums">
                  {f.timestampUtc.slice(0, 19).replace("T", " ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
