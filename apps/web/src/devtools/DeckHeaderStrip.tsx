/**
 * DevDeck-style top instrument strip for Fleet Console:
 *   - 4-host top strip (status dot, uptime/load, devtools state, clickable CI on/off switch)
 *   - Selected-host single-row telemetry gauges (CPU 5m graph, Mem, GPU 5m graph + VRAM on EVERY GPU host incl. 7A34, disks, Check hosts)
 *   - Disk-pressure action bar directly below the selected host (Run storage report / Agent cleanup review)
 */
import { T, Var, useGT } from "gt-react";
import { BotIcon, FileSearchIcon, HardDriveIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import type { MergedFleetHost } from "./devdeckTypes";
import { formatJobBytes } from "./jobs/jobTypes";

function formatUptimeShort(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 60) return "";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function diskShortLabel(
  mount: string | undefined,
  label: string | undefined,
  rootLabel: string,
): string {
  if (label && label.trim()) return label.trim();
  if (!mount || mount === "/") return rootLabel;
  const parts = mount.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? mount;
}

export function hostHasGpuTelemetry(host: MergedFleetHost | null): boolean {
  const gpu = host?.telemetry?.gpu;
  if (!gpu) return false;
  return Boolean(
    (typeof gpu.vram_total === "number" && gpu.vram_total > 0) ||
    typeof gpu.busy_pct === "number" ||
    (gpu.busy_hist && gpu.busy_hist.length > 0),
  );
}

function AreaSparkline({ values }: { readonly values: ReadonlyArray<number> }) {
  const sample = values.slice(-48);
  if (sample.length < 2) {
    return (
      <svg data-fd="gauge-spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden>
        <path data-fd="spark-base" d="M0 23.5H120M0 2H120" />
      </svg>
    );
  }
  const max = Math.max(100, ...sample);
  const coords = sample.map((v, idx) => {
    const x = (idx / (sample.length - 1)) * 120;
    const clamped = Math.max(0, Math.min(max, v));
    const y = 23 - (clamped / max) * 20;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))] as const;
  });
  const linePath = coords.map(([x, y], idx) => `${idx === 0 ? "M" : "L"}${x} ${y}`).join(" ");
  const areaPath = `${linePath} L120 24 L0 24 Z`;

  return (
    <svg data-fd="gauge-spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden>
      <path data-fd="spark-base" d="M0 23.5H120M0 2H120" />
      <path data-fd="spark-area" d={areaPath} />
      <path data-fd="spark-line" d={linePath} />
    </svg>
  );
}

function GaugeToneSr({ tone }: { readonly tone: "warn" | "bad" | undefined }) {
  const gt = useGT();
  if (tone === "bad") return <span className="sr-only">{gt("Critical: ")}</span>;
  if (tone === "warn") return <span className="sr-only">{gt("Warning: ")}</span>;
  return null;
}

export function DeckHeaderStrip({
  hosts,
  selectedHost,
  busyKeys,
  onSelectHost,
  onToggleCi,
  onCheckHosts,
  onRunStorageReport,
  onStartCleanupReview,
}: {
  readonly hosts: ReadonlyArray<MergedFleetHost>;
  readonly selectedHost: MergedFleetHost | null;
  readonly busyKeys: ReadonlySet<string>;
  readonly onSelectHost: (id: string) => void;
  readonly onToggleCi: (host: MergedFleetHost, enabled: boolean) => void;
  readonly onCheckHosts: () => void;
  readonly onRunStorageReport: (host: MergedFleetHost) => void;
  readonly onStartCleanupReview: (host: MergedFleetHost) => void;
}) {
  const gt = useGT();
  const tel = selectedHost?.telemetry ?? null;
  const cpuPct =
    typeof tel?.cpu_pct === "number" && Number.isFinite(tel.cpu_pct)
      ? Math.round(tel.cpu_pct)
      : null;
  const cpuTone =
    cpuPct !== null && cpuPct >= 95 ? "bad" : cpuPct !== null && cpuPct >= 85 ? "warn" : undefined;

  const memUsed = tel?.mem?.used ?? 0;
  const memTotal = tel?.mem?.total ?? 0;
  const memPct = memTotal > 0 ? Math.min(100, Math.round((memUsed / memTotal) * 100)) : null;
  const memTone =
    memPct !== null && memPct >= 95 ? "bad" : memPct !== null && memPct >= 80 ? "warn" : undefined;

  const gpu = tel?.gpu;
  const hasGpu = hostHasGpuTelemetry(selectedHost);
  const gpuPct =
    typeof gpu?.busy_pct === "number" && Number.isFinite(gpu.busy_pct)
      ? Math.round(gpu.busy_pct)
      : null;
  const gpuTone =
    gpuPct !== null && gpuPct >= 95 ? "bad" : gpuPct !== null && gpuPct >= 85 ? "warn" : undefined;
  const vramUsed = gpu?.vram_used ?? 0;
  const vramTotal = gpu?.vram_total ?? 0;
  const vramPct = vramTotal > 0 ? Math.min(100, Math.round((vramUsed / vramTotal) * 100)) : null;
  const vramTone =
    vramPct !== null && vramPct >= 95
      ? "bad"
      : vramPct !== null && vramPct >= 80
        ? "warn"
        : undefined;

  const disks = (tel?.disks ?? []).slice(0, 3);
  const hotDisks = disks
    .map((d) => {
      const pct = d.total && d.total > 0 ? Math.round(((d.used ?? 0) / d.total) * 100) : 0;
      return { mount: d.mount || d.label || "/", pct };
    })
    .filter((d) => d.pct >= 80);
  const maxDiskPct = disks.reduce((m, d) => {
    const pct = d.total && d.total > 0 ? Math.round(((d.used ?? 0) / d.total) * 100) : 0;
    return Math.max(m, pct);
  }, 0);

  return (
    <div className="border-b border-border bg-background">
      {/* Row 1: Full-width balanced machine cards with clear uptime/load and problem badges only when action is needed */}
      <div className="px-4 py-3">
        <div data-fd="host-grid" role="tablist" aria-label={gt("Fleet machines")}>
          {hosts.map((host) => {
            const active = selectedHost?.id === host.id;
            const up = formatUptimeShort(host.telemetry?.uptime_s);
            const load =
              typeof host.telemetry?.load1 === "number" && Number.isFinite(host.telemetry.load1)
                ? host.telemetry.load1
                : null;
            const loadHot =
              load !== null && host.telemetry?.cpus ? load > host.telemetry.cpus : false;
            const dotState =
              host.status === "offline" ? "offline" : host.problem !== null ? "degraded" : "up";
            const ciEnabled = !host.ciOff;
            const probeName = host.probeHostName ?? host.id;
            const toggling = busyKeys.has(`ci:${probeName}`);
            const canToggleCi = Boolean(host.probeHostName);
            const hasRight = canToggleCi || Boolean(host.problem);

            return (
              <div
                key={host.id}
                role="tab"
                tabIndex={0}
                aria-selected={active}
                data-fd="host-badge"
                data-selected={active}
                data-remote={!host.isLocal}
                data-has-right={hasRight}
                onClick={() => onSelectHost(host.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectHost(host.id);
                  }
                }}
              >
                <div className="min-w-0">
                  <div data-fd="host-line">
                    <span data-fd="dot" data-s={dotState} />
                    <span data-fd="host-name">{host.shortName}</span>
                  </div>
                  <div data-fd="host-meta">
                    {host.status === "offline" ? (
                      <span>{gt("offline")}</span>
                    ) : (
                      <>
                        {up ? <span>{`up ${up}`}</span> : null}
                        {up && load !== null ? <span>{" · "}</span> : null}
                        {load !== null ? (
                          <span>
                            {`${gt("load")} `}
                            <b data-warn={loadHot}>{load.toFixed(2)}</b>
                          </span>
                        ) : !up ? (
                          <span>{host.platform}</span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>

                {hasRight ? (
                  <div data-fd="host-right">
                    {host.problem ? (
                      <span data-fd="host-tag" data-tone={host.problem.tone}>
                        {host.problem.label}
                      </span>
                    ) : null}
                    {canToggleCi ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={ciEnabled}
                        aria-label={
                          ciEnabled
                            ? gt("Disable CI on {host}", { host: host.shortName })
                            : gt("Enable CI on {host}", { host: host.shortName })
                        }
                        disabled={toggling}
                        className={
                          ciEnabled
                            ? "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/40 bg-success/15 px-2.5 py-1 font-mono text-2xs font-semibold text-success-foreground transition hover:bg-success/25"
                            : "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 font-mono text-2xs font-semibold text-muted-foreground transition hover:text-foreground"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleCi(host, !ciEnabled);
                        }}
                      >
                        <span
                          className={
                            ciEnabled
                              ? "size-1.5 rounded-full bg-success"
                              : "size-1.5 rounded-full bg-muted-foreground/50"
                          }
                        />
                        <span>{ciEnabled ? gt("CI on") : gt("CI off")}</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Row 2: Full-width balanced telemetry monitor cards spanning edge-to-edge */}
      {selectedHost ? (
        <div className="border-t border-border/60 px-4 py-2.5">
          <div data-fd="gauges">
            <div data-fd="gauge" data-tone={cpuTone}>
              <div data-fd="gauge-head">
                <div data-fd="gauge-top">
                  <span data-fd="gauge-lbl">{gt("CPU")}</span>
                  <span data-fd="gauge-val">
                    <GaugeToneSr tone={cpuTone} />
                    {cpuPct !== null ? `${cpuPct}%` : "-"}
                  </span>
                </div>
                <div data-fd="gauge-sub">
                  {tel?.cpus && typeof tel.load1 === "number" && Number.isFinite(tel.load1)
                    ? gt("{cpus}c · load {load}", { cpus: tel.cpus, load: tel.load1.toFixed(2) })
                    : typeof tel?.load1 === "number" && Number.isFinite(tel.load1)
                      ? gt("load {load}", { load: tel.load1.toFixed(2) })
                      : tel?.cpus
                        ? gt("{cpus} cores", { cpus: tel.cpus })
                        : "\u00a0"}
                </div>
              </div>
              <AreaSparkline values={tel?.cpu_hist ?? []} />
            </div>

            <div data-fd="gauge" data-tone={memTone}>
              <div data-fd="gauge-head">
                <div data-fd="gauge-top">
                  <span data-fd="gauge-lbl">{gt("Mem")}</span>
                  <span data-fd="gauge-val">
                    <GaugeToneSr tone={memTone} />
                    {memPct !== null ? `${memPct}%` : "-"}
                  </span>
                </div>
                <div data-fd="gauge-sub">
                  {memTotal > 0
                    ? `${formatJobBytes(memUsed)} / ${formatJobBytes(memTotal)}`
                    : "\u00a0"}
                </div>
              </div>
              <div data-fd="bar" data-tone={memTone}>
                <i style={{ width: `${memPct ?? 0}%` }} />
              </div>
            </div>

            {hasGpu ? (
              <div data-fd="gauge" data-tone={gpuTone} data-testid="host-gpu-gauge">
                <div data-fd="gauge-head">
                  <div data-fd="gauge-top">
                    <span data-fd="gauge-lbl">{gt("GPU")}</span>
                    <span data-fd="gauge-val">
                      <GaugeToneSr tone={gpuTone} />
                      {gpuPct !== null ? `${gpuPct}%` : "-"}
                    </span>
                  </div>
                  <div data-fd="gauge-sub">{gpuPct !== null ? gt("compute load") : "\u00a0"}</div>
                </div>
                <AreaSparkline values={gpu?.busy_hist ?? []} />
              </div>
            ) : null}

            {hasGpu && vramTotal > 0 ? (
              <div data-fd="gauge" data-tone={vramTone} data-testid="host-vram-gauge">
                <div data-fd="gauge-head">
                  <div data-fd="gauge-top">
                    <span data-fd="gauge-lbl">{gt("VRAM")}</span>
                    <span data-fd="gauge-val">
                      <GaugeToneSr tone={vramTone} />
                      {vramPct !== null ? `${vramPct}%` : "-"}
                    </span>
                  </div>
                  <div data-fd="gauge-sub">
                    {`${formatJobBytes(vramUsed)} / ${formatJobBytes(vramTotal)}`}
                  </div>
                </div>
                <div data-fd="bar" data-tone={vramTone}>
                  <i style={{ width: `${vramPct ?? 0}%` }} />
                </div>
              </div>
            ) : null}

            {disks.map((disk) => {
              const mount = disk.mount || disk.label || "/";
              const total = disk.total ?? 0;
              const used = disk.used ?? 0;
              const free = Math.max(0, total - used);
              const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : null;
              const tone =
                pct !== null && pct >= 95 ? "bad" : pct !== null && pct >= 80 ? "warn" : undefined;
              return (
                <div key={mount} data-fd="gauge" data-tone={tone}>
                  <div data-fd="gauge-head">
                    <div data-fd="gauge-top">
                      <span data-fd="gauge-lbl">
                        {diskShortLabel(disk.mount, disk.label, gt("Root"))}
                      </span>
                      <span data-fd="gauge-val">
                        <GaugeToneSr tone={tone} />
                        {pct !== null ? `${pct}%` : "-"}
                      </span>
                    </div>
                    <div data-fd="gauge-sub">
                      {total > 0 ? gt("{free} free", { free: formatJobBytes(free) }) : "\u00a0"}
                    </div>
                  </div>
                  <div data-fd="bar" data-tone={tone}>
                    <i style={{ width: `${pct ?? 0}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Row 3: Per-machine storage hygiene & fleet host actions */}
      {selectedHost ? (
        <div
          className={
            maxDiskPct >= 80
              ? "flex flex-wrap items-center justify-between gap-2 border-t border-warning/35 bg-warning/8 px-4 py-1.5 text-xs"
              : "flex flex-wrap items-center justify-between gap-2 border-t border-border/50 bg-muted/15 px-4 py-1.5 text-xs"
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            <HardDriveIcon
              className={
                maxDiskPct >= 95
                  ? "size-3.5 shrink-0 text-destructive"
                  : maxDiskPct >= 80
                    ? "size-3.5 shrink-0 text-warning"
                    : "size-3.5 shrink-0 text-muted-foreground"
              }
            />
            {hotDisks.length > 0 ? (
              <span className="truncate font-medium text-foreground">
                <T>
                  Storage getting full on <Var>{selectedHost.shortName}</Var>:{" "}
                  <Var>{hotDisks.map((d) => `${d.mount} ${d.pct}%`).join(" · ")}</Var>
                </T>
              </span>
            ) : (
              <span className="truncate text-muted-foreground">
                <T>
                  Storage hygiene for <Var>{selectedHost.shortName}</Var>
                  {maxDiskPct > 0 ? ` (peak ${maxDiskPct}%)` : ""}
                </T>
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={busyKeys.has("hosts-check")}
              onClick={onCheckHosts}
            >
              <RefreshCwIcon className="mr-1 size-3" />
              <T>Check hosts</T>
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busyKeys.has(`storage-report:${selectedHost.id}`)}
              onClick={() => onRunStorageReport(selectedHost)}
            >
              <FileSearchIcon className="mr-1 size-3" />
              <T>Storage report</T>
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busyKeys.has(`storage-review:${selectedHost.id}`)}
              onClick={() => onStartCleanupReview(selectedHost)}
            >
              <BotIcon className="mr-1 size-3" />
              <T>Agent cleanup review</T>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
