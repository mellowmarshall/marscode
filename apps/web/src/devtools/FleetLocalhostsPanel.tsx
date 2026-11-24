/**
 * Per-host Localhosts & Containers panel inside Fleet Console -> Machines.
 * Folded Compose groups, Service · Port · CPU · Mem · Up, open link, Start/Stop, stopped hidden toggle.
 */
import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { DevdeckServerItem } from "./devtoolsClient";
import type { MergedFleetHost } from "./devdeckTypes";

function formatBytesShort(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}

function formatUptimeShort(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 1) return "-";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function isSafeHttpUrl(url: string | undefined): url is string {
  return Boolean(url && /^https?:\/\/[^\s]+$/i.test(url.trim()));
}

function serverOpenUrl(srv: DevdeckServerItem, isLocal: boolean): string | null {
  if (isSafeHttpUrl(srv.proxy_url)) return srv.proxy_url;
  if (isLocal && isSafeHttpUrl(srv.url)) return srv.url;
  return null;
}

export function serverActionPath(srv: DevdeckServerItem, verb: "start" | "stop"): string | null {
  if (srv.project && srv.service) {
    return `/servers/${encodeURIComponent(srv.project)}/${encodeURIComponent(srv.service)}/${verb}`;
  }
  if (srv.id) {
    return `/servers/${encodeURIComponent(srv.id)}/${verb}`;
  }
  return null;
}

export function serverActionBody(
  srv: DevdeckServerItem,
  verb: "start" | "stop",
): Record<string, unknown> | undefined {
  if (srv.container) return { container: srv.container };
  if (srv.kind === "dev" && verb === "stop" && srv.pid) return { pid: srv.pid };
  if (srv.kind === "dev" && verb === "start" && srv.dev_key) return { key: srv.dev_key };
  return undefined;
}

function isServerUp(srv: DevdeckServerItem): boolean {
  const st = (srv.state ?? "").toLowerCase();
  return st === "up" || st === "running" || st === "healthy" || st === "starting";
}

function serverRowKey(srv: DevdeckServerItem, idx: number): string {
  return srv.id || srv.container || `${srv.project ?? "p"}:${srv.service ?? idx}:${srv.port ?? ""}`;
}

export function FleetLocalhostsPanel({
  host,
  busyKeys,
  onServerAction,
}: {
  readonly host: MergedFleetHost;
  readonly busyKeys: ReadonlySet<string>;
  readonly onServerAction: (srv: DevdeckServerItem, verb: "start" | "stop") => void;
}) {
  const gt = useGT();
  const [showStopped, setShowStopped] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());

  const allServers = host.servers;
  const upServers = allServers.filter(isServerUp);
  const stoppedServers = allServers.filter((s) => !isServerUp(s));
  const visibleServers = showStopped ? allServers : upServers;

  const grouped = new Map<string, DevdeckServerItem[]>();
  const standalone: DevdeckServerItem[] = [];
  for (const srv of visibleServers) {
    const groupKey = srv.project && srv.kind !== "dev" ? srv.project : "";
    if (groupKey) {
      const list = grouped.get(groupKey) ?? [];
      list.push(srv);
      grouped.set(groupKey, list);
    } else {
      standalone.push(srv);
    }
  }

  const toggleGroup = (name: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const renderServerRow = (srv: DevdeckServerItem, idx: number, indented: boolean) => {
    const key = serverRowKey(srv, idx);
    const up = isServerUp(srv);
    const openUrl = up ? serverOpenUrl(srv, host.isLocal) : null;
    const verb: "start" | "stop" = up ? "stop" : "start";
    const canAct = host.isLocal && serverActionPath(srv, verb) !== null;
    const isBusy = busyKeys.has(`srv:${key}:${verb}`);
    const portText = srv.port ? `:${srv.port}` : "-";
    const cpuText =
      typeof srv.cpu_pct === "number" && Number.isFinite(srv.cpu_pct)
        ? `${srv.cpu_pct.toFixed(srv.cpu_pct >= 10 ? 0 : 1)}%`
        : "-";
    const memText = formatBytesShort(srv.mem_bytes);
    const upText = up ? formatUptimeShort(srv.uptime_s) : gt("stopped");

    return (
      <div
        key={key}
        className={
          indented
            ? "flex items-center justify-between gap-2 bg-muted/10 py-1.5 pr-3 pl-8 text-xs hover:bg-muted/20"
            : "flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-muted/20"
        }
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={
              up
                ? "size-2 shrink-0 rounded-full bg-success"
                : "size-2 shrink-0 rounded-full bg-muted-foreground/35"
            }
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-foreground">
                {srv.service || srv.container || srv.id || key}
              </span>
              {srv.kind === "dev" && !srv.managed ? (
                <Badge size="sm" variant="outline">
                  <T>dev</T>
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 font-mono text-3xs text-muted-foreground tabular-nums">
          <span>{portText}</span>
          <span className="w-10 text-right">{cpuText}</span>
          <span className="w-11 text-right">{memText}</span>
          <span className="w-10 text-right">{upText}</span>
          <div className="flex w-12 items-center justify-end gap-0.5">
            {openUrl ? (
              <a
                href={openUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={gt("Open {name}", {
                  name: srv.service || srv.container || srv.id || "service",
                })}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-info-foreground"
              >
                <ExternalLinkIcon className="size-3" />
              </a>
            ) : null}
            {canAct ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={isBusy}
                aria-label={
                  up
                    ? gt("Stop {name}", {
                        name: srv.service || srv.container || srv.id || "service",
                      })
                    : gt("Start {name}", {
                        name: srv.service || srv.container || srv.id || "service",
                      })
                }
                onClick={() => onServerAction(srv, verb)}
              >
                {up ? (
                  <SquareIcon className="size-3 text-destructive" />
                ) : (
                  <PlayIcon className="size-3 text-success" />
                )}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-card/40">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <GlobeIcon className="size-3.5 text-muted-foreground" />
          <T>Localhosts & Containers</T>
          <Badge size="sm" variant="secondary">
            <T>
              <Var>{upServers.length}</Var> up
            </T>
          </Badge>
        </div>
        {stoppedServers.length > 0 ? (
          <button
            type="button"
            className="font-mono text-3xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowStopped((v) => !v)}
          >
            {showStopped
              ? gt("Hide {n} stopped", { n: stoppedServers.length })
              : gt("{n} stopped hidden", { n: stoppedServers.length })}
          </button>
        ) : null}
      </div>

      {visibleServers.length === 0 ? (
        <div className="px-3 py-5 text-xs text-muted-foreground">
          <T>No running localhosts or containers on this host.</T>
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {Array.from(grouped.entries()).map(([project, items]) => {
            if (items.length === 1) {
              return renderServerRow(items[0]!, 0, false);
            }
            const expanded = openGroups.has(project);
            const runningInGroup = items.filter(isServerUp).length;
            const totalMem = items.reduce((sum, s) => sum + (s.mem_bytes ?? 0), 0);
            const totalCpu = items.reduce((sum, s) => sum + (s.cpu_pct ?? 0), 0);
            return (
              <div key={project}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-muted/20"
                  onClick={() => toggleGroup(project)}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {expanded ? (
                      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={
                        runningInGroup > 0
                          ? "size-2 shrink-0 rounded-full bg-success"
                          : "size-2 shrink-0 rounded-full bg-muted-foreground/35"
                      }
                    />
                    <span className="truncate font-semibold text-foreground">{project}</span>
                    <span className="font-mono text-3xs text-muted-foreground">
                      {`${runningInGroup}/${items.length}`}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 font-mono text-3xs text-muted-foreground tabular-nums">
                    <span>{totalCpu > 0 ? `${totalCpu.toFixed(0)}%` : "-"}</span>
                    <span>{formatBytesShort(totalMem)}</span>
                  </div>
                </button>
                {expanded ? (
                  <div className="divide-y divide-border/40 border-t border-border/40">
                    {items.map((srv, idx) => renderServerRow(srv, idx, true))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {standalone.map((srv, idx) => renderServerRow(srv, idx, false))}
        </div>
      )}
    </section>
  );
}
