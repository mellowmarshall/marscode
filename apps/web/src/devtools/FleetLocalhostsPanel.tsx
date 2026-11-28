/**
 * Per-host Localhosts & Containers panel inside Fleet Console -> Machines.
 * Folded Compose groups, Service · Port · CPU · Memory · Up, open link, Start/Stop, stopped hidden toggle.
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
import { FleetPanel } from "./FleetPanel";

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

// Below a 32rem panel the port and uptime columns drop so the name keeps room.
const COLS =
  "grid-cols-[minmax(6rem,1fr)_3.5rem_4rem_3.5rem] @lg:grid-cols-[minmax(0,1fr)_3.5rem_3.5rem_4rem_3rem_3.5rem]";
const WIDE = "hidden @lg:block";
const ROW = `grid ${COLS} items-center gap-x-3 py-2 pr-3`;

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

  const metric = "text-right font-mono text-sm text-muted-foreground tabular-nums";

  const renderServerRow = (srv: DevdeckServerItem, idx: number, indented: boolean) => {
    const key = serverRowKey(srv, idx);
    const up = isServerUp(srv);
    const openUrl = up ? serverOpenUrl(srv, host.isLocal) : null;
    const verb: "start" | "stop" = up ? "stop" : "start";
    const canAct = host.isLocal && serverActionPath(srv, verb) !== null;
    const isBusy = busyKeys.has(`srv:${key}:${verb}`);
    const name = srv.service || srv.container || srv.id || key;
    const cpuText =
      typeof srv.cpu_pct === "number" && Number.isFinite(srv.cpu_pct)
        ? `${srv.cpu_pct.toFixed(srv.cpu_pct >= 10 ? 0 : 1)}%`
        : "-";

    return (
      <div
        key={key}
        className={`${ROW} hover:bg-muted/20 ${indented ? "bg-muted/10 pl-9" : "pl-3"}`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={
              up
                ? "size-2 shrink-0 rounded-full bg-success"
                : "size-2 shrink-0 rounded-full bg-muted-foreground/35"
            }
          />
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          {srv.kind === "dev" && !srv.managed ? (
            <Badge size="sm" variant="outline">
              <T>dev</T>
            </Badge>
          ) : null}
        </div>
        <span className={`${WIDE} ${metric}`}>{srv.port ? `:${srv.port}` : "-"}</span>
        <span className={metric}>{cpuText}</span>
        <span className={metric}>{formatBytesShort(srv.mem_bytes)}</span>
        <span className={`${WIDE} ${metric}`}>
          {up ? formatUptimeShort(srv.uptime_s) : gt("stopped")}
        </span>
        <div className="flex items-center justify-end gap-0.5">
          {openUrl ? (
            <Button
              size="icon-xs"
              variant="ghost"
              render={<a href={openUrl} target="_blank" rel="noreferrer" />}
              aria-label={gt("Open {name}", { name })}
            >
              <ExternalLinkIcon />
            </Button>
          ) : null}
          {canAct ? (
            <Button
              size="icon-xs"
              variant={up ? "ghost-destructive" : "ghost"}
              disabled={isBusy}
              aria-label={up ? gt("Stop {name}", { name }) : gt("Start {name}", { name })}
              onClick={() => onServerAction(srv, verb)}
            >
              {up ? (
                <SquareIcon className="size-3 fill-current" />
              ) : (
                <PlayIcon className="size-3.5 fill-current text-success" />
              )}
            </Button>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <FleetPanel.Root data-testid="fleet-localhosts-panel">
      <FleetPanel.Header>
        <FleetPanel.Title>
          <GlobeIcon />
          <T>Localhosts & containers</T>
          <Badge variant="secondary">
            <T>
              <Var>{upServers.length}</Var> up
            </T>
          </Badge>
        </FleetPanel.Title>
        {stoppedServers.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => setShowStopped((v) => !v)}>
            {showStopped
              ? gt("Hide {n} stopped", { n: stoppedServers.length })
              : gt("Show {n} stopped", { n: stoppedServers.length })}
          </Button>
        ) : null}
      </FleetPanel.Header>
      {visibleServers.length === 0 ? null : (
        <FleetPanel.Columns className={COLS}>
          <span>
            <T>Service</T>
          </span>
          <span className={WIDE}>
            <T>Port</T>
          </span>
          <span>
            <T>CPU</T>
          </span>
          <span>
            <T>Memory</T>
          </span>
          <span className={WIDE}>
            <T>Uptime</T>
          </span>
          <span />
        </FleetPanel.Columns>
      )}

      {visibleServers.length === 0 ? (
        <FleetPanel.Empty>
          <T>No running localhosts or containers on this host.</T>
        </FleetPanel.Empty>
      ) : (
        <FleetPanel.Body>
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
                  aria-expanded={expanded}
                  className={`${ROW} w-full pl-3 text-left hover:bg-muted/20`}
                  onClick={() => toggleGroup(project)}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={
                        runningInGroup > 0
                          ? "size-2 shrink-0 rounded-full bg-success"
                          : "size-2 shrink-0 rounded-full bg-muted-foreground/35"
                      }
                    />
                    <span className="truncate text-sm font-semibold text-foreground">
                      {project}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {`${runningInGroup}/${items.length}`}
                    </span>
                  </span>
                  <span className={`${WIDE} ${metric}`} />
                  <span className={metric}>{totalCpu > 0 ? `${totalCpu.toFixed(0)}%` : "-"}</span>
                  <span className={metric}>{formatBytesShort(totalMem)}</span>
                  <span className={`${WIDE} ${metric}`} />
                  <span className="flex justify-end text-muted-foreground">
                    {expanded ? (
                      <ChevronDownIcon className="size-4" />
                    ) : (
                      <ChevronRightIcon className="size-4" />
                    )}
                  </span>
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
        </FleetPanel.Body>
      )}
    </FleetPanel.Root>
  );
}
