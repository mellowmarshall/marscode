import { T, useGT } from "gt-react";
import { useState } from "react";

import {
  formatMetricValue,
  isPlottableSeries,
  type ParsedJobMetricPoint,
  type ParsedJobMetricSeries,
} from "./jobOutputParser";

interface PlottedPoint {
  readonly point: ParsedJobMetricPoint;
  readonly cx: number;
  readonly cy: number;
  readonly anomaly: boolean;
}

function projectSeries(
  points: ReadonlyArray<ParsedJobMetricPoint>,
  width: number,
  height: number,
  padX: number,
  padY: number,
  useLog: boolean,
): {
  readonly linePath: string;
  readonly areaPath: string;
  readonly plotted: ReadonlyArray<PlottedPoint>;
  readonly canLog: boolean;
} {
  if (points.length === 0) {
    return { linePath: "", areaPath: "", plotted: [], canLog: false };
  }

  const finiteValues: number[] = [];
  let allPositive = true;
  for (const pt of points) {
    if (!pt.anomaly && pt.value !== null && Number.isFinite(pt.value)) {
      finiteValues.push(pt.value);
      if (pt.value <= 0) allPositive = false;
    }
  }

  const canLog = finiteValues.length >= 2 && allPositive;
  const logActive = useLog && canLog;
  const minVal = finiteValues.length > 0 ? Math.min(...finiteValues) : 0;
  const maxVal = finiteValues.length > 0 ? Math.max(...finiteValues) : 1;

  const projectY = (value: number): number => {
    const tv = logActive ? Math.log10(value) : value;
    const tMin = logActive ? Math.log10(minVal) : minVal;
    const tMax = logActive ? Math.log10(maxVal) : maxVal;
    const span = tMax - tMin;
    const norm = span > 1e-12 ? (tv - tMin) / span : 0.5;
    return padY + (1 - norm) * (height - padY * 2);
  };

  const innerW = Math.max(1, width - padX * 2);
  const denom = Math.max(1, points.length - 1);
  const plotted: Array<PlottedPoint> = [];
  let linePath = "";
  let areaPath = "";
  let segmentStart: { cx: number; cy: number } | null = null;
  let lastFinite: { cx: number; cy: number } | null = null;
  const baselineY = height - padY;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const cx = padX + (i / denom) * innerW;
    if (point.anomaly || point.value === null || !Number.isFinite(point.value)) {
      if (segmentStart && lastFinite) {
        areaPath += ` L${lastFinite.cx.toFixed(1)},${baselineY.toFixed(1)} L${segmentStart.cx.toFixed(1)},${baselineY.toFixed(1)} Z`;
      }
      segmentStart = null;
      lastFinite = null;
      plotted.push({ point, cx, cy: padY + 6, anomaly: true });
      continue;
    }

    const cy = projectY(point.value);
    plotted.push({ point, cx, cy, anomaly: false });
    if (segmentStart === null) {
      segmentStart = { cx, cy };
      linePath += ` M${cx.toFixed(1)},${cy.toFixed(1)}`;
      areaPath += ` M${cx.toFixed(1)},${cy.toFixed(1)}`;
    } else {
      linePath += ` L${cx.toFixed(1)},${cy.toFixed(1)}`;
      areaPath += ` L${cx.toFixed(1)},${cy.toFixed(1)}`;
    }
    lastFinite = { cx, cy };
  }

  if (segmentStart && lastFinite) {
    areaPath += ` L${lastFinite.cx.toFixed(1)},${baselineY.toFixed(1)} L${segmentStart.cx.toFixed(1)},${baselineY.toFixed(1)} Z`;
  }

  return {
    linePath: linePath.trim(),
    areaPath: areaPath.trim(),
    plotted,
    canLog,
  };
}

export function JobSparkline({
  series,
  width = 58,
  height = 18,
  stroke = "var(--chart-1)",
}: {
  readonly series: ParsedJobMetricSeries;
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
}) {
  if (!isPlottableSeries(series)) return null;
  const { linePath, plotted } = projectSeries(series.points, width, height, 2, 2, false);
  const anomalies = plotted.filter((item) => item.anomaly);

  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
    >
      {linePath ? (
        <path
          d={linePath}
          fill="none"
          stroke={stroke}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {anomalies.map((item) => (
        <circle key={item.point.index} cx={item.cx} cy={item.cy} r={2} fill="var(--destructive)" />
      ))}
    </svg>
  );
}

export function JobMetricChart({
  series,
  stroke = "var(--chart-1)",
}: {
  readonly series: ParsedJobMetricSeries;
  readonly stroke?: string;
}) {
  const gt = useGT();
  const [useLog, setUseLog] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!isPlottableSeries(series)) return null;

  const width = 300;
  const height = 108;
  const padX = 8;
  const padY = 10;
  const { linePath, areaPath, plotted, canLog } = projectSeries(
    series.points,
    width,
    height,
    padX,
    padY,
    useLog,
  );
  const hovered =
    hoverIndex !== null ? (plotted.find((item) => item.point.index === hoverIndex) ?? null) : null;
  const latest = plotted.at(-1) ?? null;
  const readout = hovered ?? latest;

  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-foreground">{series.label}</span>
          {readout ? (
            <span className="font-mono text-2xs text-muted-foreground tabular-nums">
              {readout.point.step !== null
                ? gt("step {step}: {value}", {
                    step: readout.point.step,
                    value: formatMetricValue(readout.point.value, readout.point.anomaly),
                  })
                : formatMetricValue(readout.point.value, readout.point.anomaly)}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canLog ? (
            <button
              type="button"
              onClick={() => setUseLog((prev) => !prev)}
              className="cursor-pointer rounded px-1.5 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {useLog ? <T>Log10</T> : <T>Linear</T>}
            </button>
          ) : (
            <span className="font-mono text-2xs text-muted-foreground tabular-nums">
              {gt("{count} pts", { count: series.points.length })}
            </span>
          )}
        </div>
      </div>

      <svg
        role="img"
        aria-label={series.label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-28 w-full overflow-visible"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line
          x1={padX}
          y1={padY}
          x2={width - padX}
          y2={padY}
          stroke="var(--border)"
          strokeDasharray="2 3"
        />
        <line
          x1={padX}
          y1={height / 2}
          x2={width - padX}
          y2={height / 2}
          stroke="var(--border)"
          strokeDasharray="2 3"
        />
        <line
          x1={padX}
          y1={height - padY}
          x2={width - padX}
          y2={height - padY}
          stroke="var(--border)"
        />
        {areaPath ? <path d={areaPath} fill={stroke} fillOpacity={0.12} /> : null}
        {linePath ? (
          <path
            d={linePath}
            fill="none"
            stroke={stroke}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {hovered ? (
          <line
            x1={hovered.cx}
            y1={padY}
            x2={hovered.cx}
            y2={height - padY}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ) : null}
        {readout && !readout.anomaly ? (
          <circle cx={readout.cx} cy={readout.cy} r={3.2} fill={stroke} />
        ) : null}
        {plotted
          .filter((item) => item.anomaly)
          .map((item) => (
            <circle
              key={`anomaly-${item.point.index}`}
              cx={item.cx}
              cy={item.cy}
              r={3.5}
              fill="var(--destructive)"
            />
          ))}
        {plotted.map((item) => (
          <circle
            key={`hit-${item.point.index}`}
            cx={item.cx}
            cy={item.cy}
            r={7}
            fill="transparent"
            className="cursor-crosshair"
            onMouseEnter={() => setHoverIndex(item.point.index)}
          />
        ))}
      </svg>
    </div>
  );
}
