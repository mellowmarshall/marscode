/**
 * The text form of `playbook stats`: the original playbook CLI's review-stats table. Its header
 * reads `(side=S, by=G): N reviews` where the original put an em dash (this repo forbids them in copy).
 */
import type { ReviewStatsGroupRow, ReviewStatsResponse } from "./statsTypes.ts";

const COLUMNS = ["GROUP", "REVIEWS", "PASS%", "TOTAL", "BRK", "CRIT", "HIGH", "MED", "LOW", "AVG"];

/** Python's `f"{x:.0f}"`: round half to even. */
function fixed0(x: number): string {
  const floor = Math.floor(x);
  const diff = x - floor;
  const rounded = diff === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(x);
  return String(rounded);
}

function countsLine(c: ReviewStatsGroupRow): string {
  const parts = [
    `${c.breaking} breaking`,
    `${c.critical} critical`,
    `${c.high} high`,
    `${c.medium} medium`,
    `${c.low} low`,
  ];
  if (c.info) parts.push(`${c.info} info`);
  return parts.join(", ");
}

export function formatStatsTable(stats: ReviewStatsResponse): string {
  const tot = stats.totals;
  const header =
    `Review Stats (side=${stats.side}, by=${stats.by}): ${tot.reviews} reviews, ` +
    `${tot.total} issues (${countsLine(tot)})`;
  if (stats.groups.length === 0) return `${header}\n  (no matching reviews)`;
  const data = stats.groups.map((r) => [
    r.key.slice(0, 42),
    String(r.reviews),
    `${fixed0(r.passRatePct)}%`,
    String(r.total),
    String(r.breaking),
    String(r.critical),
    String(r.high),
    String(r.medium),
    String(r.low),
    r.avgIssues.toFixed(2),
  ]);
  const widths = COLUMNS.map((col, i) => Math.max(col.length, ...data.map((d) => d[i]!.length)));
  const lines = [
    header,
    COLUMNS.map((col, i) => col.padEnd(widths[i]!)).join("  "),
    widths.map((w) => "-".repeat(w)).join("  "),
  ];
  for (const d of data) {
    lines.push(
      d
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
        .join("  "),
    );
  }
  return lines.join("\n");
}
