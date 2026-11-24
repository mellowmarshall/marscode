/**
 * Zero-dependency SVG charts for Bounded Jobs:
 * - `<JobSparkline />`: compact right-rail metric curve
 * - `<JobMetricChart />`: fullscreen Fleet Console curve with hover crosshair, log toggle, and NaN/Inf markers
 */
import { useState } from "react";
import { T, useGT } from "gt-react";

import {
  formatMetricNumber,
  type JobMetricPoint,
  type JobMetricSeries,
  type JobSparklineSummary,
} from "./jobTypes";

function computeCoords(
  points: ReadonlyArray<JobMetricPoint>,
  width: number,
  height: number,
  padX: number,
  padY: number,
  useLog: boolean,
): {
  readonly pathD: string;
  readonly mapped: ReadonlyArray<{
    readonly idx: number;
    readonly cx: number;
    readonly cy: number;
    readonly point: JobMetricPoint;
    readonly anomaly: boolean;
  }>;
  readonly minVal: number | null;
  readonly maxVal: number | null;
  readonly canLog: boolean;
} {
  if (points.length === 0) {
    return { pathD: "", mapped: [], minVal: null, maxVal: null, canLog: false };
  }
  const finiteValues: number[] = [];
  let allPositive = true;
  for (const pt of points) {
    if (pt.v !== null && Number.isFinite(pt.v) && !pt.anomaly) {
      finiteValues.push(pt.v);
      if (pt.v <= 0) allPositive = false;
    }
  }
  const canLog = finiteValues.length >= 2 && allPositive;
  const logActive = useLog && canLog;
  const minVal = finiteValues.length > 0 ? Math.min(...finiteValues) : null;
  const maxVal = finiteValues.length > 0 ? Math.max(...finiteValues) : null;

  const projectY = (v: number): number => {
    const tv = logActive ? Math.log10(v) : v;
    const tMin = minVal !== null ? (logActive ? Math.log10(minVal) : minVal) : 0;
    const tMax = maxVal !== null ? (logActive ? Math.log10(maxVal) : maxVal) : 1;
    const span = tMax - tMin;
    const norm = span > 1e-12 ? (tv - tMin) / span : 0.5;
    return padY + (1 - norm) * (height - padY * 2);
  };

  const innerW = Math.max(1, width - padX * 2);
  const denom = Math.max(1, points.length - 1);
  const mapped: Array<{
    readonly idx: number;
    readonly cx: number;
    readonly cy: number;
    readonly point: JobMetricPoint;
    readonly anomaly: boolean;
  }> = [];

  let pathD = "";
  let penDown = false;
  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i]!;
    const cx = padX + (i / denom) * innerW;
    if (pt.anomaly || pt.v === null || !Number.isFinite(pt.v)) {
      penDown = false;
      mapped.push({ idx: i, cx, cy: padY + 4, point: pt, anomaly: true });
      continue;
    }
    const cy = projectY(pt.v);
    mapped.push({ idx: i, cx, cy, point: pt, anomaly: false });
    pathD += `${penDown ? " L" : " M"}${cx.toFixed(1)},${cy.toFixed(1)}`;
    penDown = true;
  }

  return { pathD: pathD.trim(), mapped, minVal, maxVal, canLog };
}

export function isPlottableSeries(series: Pick<JobMetricSeries, "points">): boolean {
  let minVal = Number.POSITIVE_INFINITY;
  let maxVal = Number.NEGATIVE_INFINITY;
  let finiteCount = 0;
  for (const pt of series.points) {
    if (pt.anomaly) return true;
    if (pt.v !== null && Number.isFinite(pt.v)) {
      finiteCount += 1;
      if (pt.v < minVal) minVal = pt.v;
      if (pt.v > maxVal) maxVal = pt.v;
    }
  }
  return finiteCount >= 2 && maxVal - minVal > 1e-12;
}

export function JobSparkline({
  sparkline,
  width = 48,
  height = 12,
}: {
  readonly sparkline: JobSparklineSummary;
  readonly width?: number;
  readonly height?: number;
}) {
  const points: JobMetricPoint[] = sparkline.values.map((v, i) => ({
    t: i,
    v,
    ...(v === null ? { anomaly: "nan" as const } : {}),
  }));
  if (!isPlottableSeries({ points })) return null;
  const { pathD, mapped } = computeCoords(points, width, height, 1, 1, false);
  const latest = points.at(-1);

  return (
    <div className="flex items-center justify-between gap-2 font-mono text-3xs text-muted-foreground tabular-nums">
      <span className="truncate">
        {sparkline.label ? `${sparkline.label} ` : ""}
        <span className={latest?.anomaly ? "font-medium text-destructive" : "text-foreground/85"}>
          {formatMetricNumber(latest?.v ?? null, latest?.anomaly)}
        </span>
      </span>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="shrink-0 overflow-visible text-info-foreground"
        aria-hidden
      >
        {pathD ? (
          <path
            d={pathD}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {mapped
          .filter((m) => m.anomaly)
          .map((m) => (
            <circle key={m.idx} cx={m.cx} cy={m.cy} r="2" className="fill-destructive" />
          ))}
      </svg>
    </div>
  );
}

export function JobMetricChart({ series }: { readonly series: JobMetricSeries }) {
  const gt = useGT();
  const [logScale, setLogScale] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!isPlottableSeries(series)) return null;

  const width = 440;
  const height = 148;
  const padX = 10;
  const padY = 12;
  const { pathD, mapped, minVal, maxVal, canLog } = computeCoords(
    series.points,
    width,
    height,
    padX,
    padY,
    logScale,
  );
  const activeEntry = hoverIdx !== null ? (mapped[hoverIdx] ?? null) : null;
  const latest = series.points.at(-1);
  const displayPoint = activeEntry?.point ?? latest ?? null;

  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{series.label}</span>
            {series.unit ? (
              <span className="font-mono text-3xs text-muted-foreground">{series.unit}</span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-3xs text-muted-foreground tabular-nums">
            {minVal !== null ? <span>{`min ${formatMetricNumber(minVal)}`}</span> : null}
            {maxVal !== null ? <span>{`max ${formatMetricNumber(maxVal)}`}</span> : null}
            <span>{`${series.points.length} pts`}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right font-mono tabular-nums">
            <div
              className={
                displayPoint?.anomaly
                  ? "text-sm font-semibold text-destructive"
                  : "text-sm font-semibold text-foreground"
              }
            >
              {formatMetricNumber(displayPoint?.v ?? null, displayPoint?.anomaly)}
            </div>
            {activeEntry?.point.x !== undefined ? (
              <div className="text-3xs text-muted-foreground">{`x=${activeEntry.point.x}`}</div>
            ) : null}
          </div>
          {canLog ? (
            <button
              type="button"
              onClick={() => setLogScale((prev) => !prev)}
              aria-pressed={logScale}
              aria-label={gt("Toggle log scale for {label}", { label: series.label })}
              className={
                logScale
                  ? "rounded border bg-secondary px-1.5 py-0.5 font-mono text-3xs text-foreground"
                  : "rounded border px-1.5 py-0.5 font-mono text-3xs text-muted-foreground hover:text-foreground"
              }
            >
              <T>log</T>
            </button>
          ) : null}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-36 w-full select-none overflow-visible text-info-foreground"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(ev) => {
          if (mapped.length === 0) return;
          const rect = ev.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) return;
          const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
          const idx = Math.round(ratio * (mapped.length - 1));
          setHoverIdx(idx);
        }}
      >
        <line
          x1={padX}
          y1={height - padY}
          x2={width - padX}
          y2={height - padY}
          className="stroke-border"
          strokeWidth="1"
        />
        <line
          x1={padX}
          y1={padY}
          x2={width - padX}
          y2={padY}
          className="stroke-border/50"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        {pathD ? (
          <path
            d={pathD}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {mapped
          .filter((m) => m.anomaly)
          .map((m) => (
            <circle key={m.idx} cx={m.cx} cy={m.cy} r="3.5" className="fill-destructive" />
          ))}
        {activeEntry ? (
          <>
            <line
              x1={activeEntry.cx}
              y1={padY}
              x2={activeEntry.cx}
              y2={height - padY}
              className="stroke-muted-foreground/50"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
            <circle
              cx={activeEntry.cx}
              cy={activeEntry.cy}
              r="3.5"
              className={activeEntry.anomaly ? "fill-destructive" : "fill-info-foreground"}
            />
          </>
        ) : null}
      </svg>
    </div>
  );
}
