import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { AlertTriangleIcon, ServerIcon } from "lucide-react";
import { useEffect } from "react";

import { isElectron } from "~/env";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useVisibleThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { ResourceTelemetryDiagnostics } from "../settings/ResourceTelemetryDiagnostics";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { MachineCardStrip } from "./MachineCardStrip";
import { MachineJobsPanel } from "./MachineJobsPanel";
import { MachineServersPanel } from "./MachineServersPanel";
import { MachineShipQueuePanel } from "./MachineShipQueuePanel";
import { MachineTelemetryCards } from "./MachineTelemetryCards";
import { MachineThreadsPanel } from "./MachineThreadsPanel";
import { isDepHoldActionable } from "../../lib/shipQueueApprovals";
import { isShipQueueJobLive } from "../../lib/shipQueueSteps";
import { useShipQueueSnapshot } from "../../state/shipQueue";
import {
  type MachinesTab,
  readMachinesTab,
  selectEnvironmentBackgroundJobs,
  sortMachineEnvironments,
} from "./machines.logic";

export interface MachinesSearch {
  readonly env?: string;
  readonly tab?: MachinesTab;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function buildMachinesSearch(env: string | undefined, tab: MachinesTab): MachinesSearch {
  return {
    ...(env ? { env } : {}),
    ...(tab !== "overview" ? { tab } : {}),
  };
}

export function MachinesPage() {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const search = useSearch({ from: "/_chat/machines" });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const allThreads = useVisibleThreadShells();

  const sortedEnvironments = sortMachineEnvironments(environments, primaryEnvironmentId);
  const askedEnvironmentId = search.env ? EnvironmentId.make(search.env) : null;
  const selectedEnvironment =
    (askedEnvironmentId
      ? sortedEnvironments.find((environment) => environment.environmentId === askedEnvironmentId)
      : null) ??
    sortedEnvironments.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    sortedEnvironments[0] ??
    null;

  const selectedId = selectedEnvironment?.environmentId ?? null;
  const selectedConnected = selectedEnvironment?.connection.phase === "connected";
  const tab: MachinesTab = readMachinesTab(search.tab);

  const updateSearch = (patch: Partial<MachinesSearch>) => {
    const nextEnv = patch.env !== undefined ? patch.env : (selectedId ?? undefined);
    const nextTab = patch.tab !== undefined ? patch.tab : tab;
    void navigate({
      to: "/machines",
      search: buildMachinesSearch(nextEnv, nextTab),
      replace: true,
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribe to window keyboard shortcuts for cycling selected machines
  useEffect(() => {
    if (environments.length <= 1) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (event.key !== "[" && event.key !== "]") return;

      const ordered = sortMachineEnvironments(environments, primaryEnvironmentId);
      if (ordered.length <= 1) return;
      const currentIndex = ordered.findIndex((env) => env.environmentId === selectedId);
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const offset = event.key === "]" ? 1 : -1;
      const next = ordered[(baseIndex + offset + ordered.length) % ordered.length];
      if (!next || next.environmentId === selectedId) return;

      event.preventDefault();
      void navigate({
        to: "/machines",
        search: buildMachinesSearch(next.environmentId, tab),
        replace: true,
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [environments, primaryEnvironmentId, selectedId, tab, navigate]);

  const hardware = useEnvironmentQuery(
    selectedEnvironment && selectedConnected
      ? serverEnvironment.hostHardware({
          environmentId: selectedEnvironment.environmentId,
          input: {},
        })
      : null,
    messages,
  );
  const session = useEnvironmentQuery(
    selectedEnvironment
      ? environmentSession.sessionStateAtom(selectedEnvironment.environmentId)
      : null,
    messages,
  );
  const diagnosticsAccess = resolveUsageAccess(
    {
      connectionPhase: selectedEnvironment?.connection.phase ?? "available",
      session: session.data,
      hasSessionError: session.error !== null,
    },
    messages,
  );

  const handleRefresh = () => {
    if (selectedEnvironment && selectedConnected) {
      hardware.refresh();
    }
    for (const environment of sortedEnvironments) {
      if (environment.connection.phase === "connected") {
        appAtomRegistry.refresh(
          serverEnvironment.hostResources({
            environmentId: environment.environmentId,
            input: {},
          }),
        );
      }
    }
  };

  const isRefreshing = selectedConnected && hardware.isPending;
  const shipQueueSupported =
    selectedEnvironment?.serverConfig?.environment.capabilities.shipQueue === true;
  const activeTab: MachinesTab = tab === "ship-queue" && !shipQueueSupported ? "overview" : tab;
  const shipQueueSnapshot = useShipQueueSnapshot(
    selectedEnvironment && selectedConnected && shipQueueSupported
      ? selectedEnvironment.environmentId
      : null,
  );
  const shipQueueCount = shipQueueSnapshot.available
    ? shipQueueSnapshot.jobs.filter(isShipQueueJobLive).length +
      shipQueueSnapshot.deps.filter(isDepHoldActionable).length
    : 0;
  const knownShipJobIds =
    shipQueueSupported && shipQueueSnapshot.available && shipQueueSnapshot.jobs.length > 0
      ? new Set(shipQueueSnapshot.jobs.map((job) => job.id))
      : undefined;
  const activeJobsCount =
    selectedId && selectedConnected
      ? selectEnvironmentBackgroundJobs(allThreads, selectedId, {
          excludeShipQueue: shipQueueSupported,
          knownShipJobIds,
        }).length
      : 0;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} reserveNativeControls className="border-b">
          <WorkspaceBreadcrumb ariaLabel={gt("Machines breadcrumb")} className="flex-1">
            <WorkspaceBreadcrumbItem current={selectedEnvironment === null}>
              {selectedEnvironment === null ? (
                <h1 className="truncate">
                  <WorkspaceBreadcrumbText>
                    <T>Machines</T>
                  </WorkspaceBreadcrumbText>
                </h1>
              ) : (
                <WorkspaceBreadcrumbText>
                  <T>Machines</T>
                </WorkspaceBreadcrumbText>
              )}
            </WorkspaceBreadcrumbItem>
            {selectedEnvironment !== null ? (
              <>
                <WorkspaceBreadcrumbSeparator>
                  <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
                  <h1 className="min-w-0">
                    <WorkspaceBreadcrumbText>{selectedEnvironment.label}</WorkspaceBreadcrumbText>
                  </h1>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>

          {sortedEnvironments.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={gt("Refresh machine metrics")}
                    aria-busy={isRefreshing}
                    disabled={!selectedConnected || isRefreshing}
                    onClick={handleRefresh}
                  >
                    <RefreshIcon size="sm" refreshing={isRefreshing} />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">{gt("Refresh machine metrics")}</TooltipPopup>
            </Tooltip>
          ) : null}
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="flex flex-col gap-6 py-5">
            {sortedEnvironments.length === 0 ? (
              <div className="rounded-xl border border-border/70 bg-card">
                <Empty>
                  <EmptyMedia variant="icon">
                    <ServerIcon />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>
                      <T>No machines connected</T>
                    </EmptyTitle>
                    <EmptyDescription>
                      <T>
                        Connect a local or remote T3 Code environment in{" "}
                        <Link
                          to="/settings/connections"
                          className="underline underline-offset-4 hover:text-foreground"
                        >
                          Settings → Connections
                        </Link>
                        .
                      </T>
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <>
                <MachineCardStrip
                  environments={sortedEnvironments}
                  primaryEnvironmentId={primaryEnvironmentId}
                  selectedEnvironmentId={selectedId}
                  onSelect={(environmentId) => updateSearch({ env: environmentId })}
                />

                {selectedEnvironment !== null ? (
                  <div className="flex min-w-0 flex-col gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(selectedEnvironment.serverConfig)}
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <h2 className="min-w-0 truncate text-base font-medium text-foreground">
                          {selectedEnvironment.label}
                        </h2>
                        <ConnectionStatusDot
                          dotClassName={connectionPhaseDotClassName(
                            selectedEnvironment.connection.phase,
                          )}
                          pingClassName={connectionPhasePingClassName(
                            selectedEnvironment.connection.phase,
                          )}
                        />
                        {selectedConnected && selectedEnvironment.displayUrl ? (
                          <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
                            {selectedEnvironment.displayUrl}
                          </span>
                        ) : !selectedConnected ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {connectionStatusTitle(selectedEnvironment.connection, messages)}
                          </span>
                        ) : null}
                      </div>

                      {selectedConnected ? (
                        <ToggleGroup
                          aria-label={gt("Machine view")}
                          className="max-w-full flex-wrap"
                          variant="segmented"
                          value={[activeTab]}
                          onValueChange={(next) => {
                            const value = next[0];
                            if (value) updateSearch({ tab: readMachinesTab(value) });
                          }}
                        >
                          <Toggle value="overview">
                            <T>Overview</T>
                          </Toggle>
                          <Toggle value="processes">
                            <T>Processes</T>
                          </Toggle>
                          <Toggle value="jobs">
                            <T>Jobs</T>
                            {activeJobsCount > 0 ? (
                              <span className="text-2xs text-muted-foreground tabular-nums">
                                {activeJobsCount}
                              </span>
                            ) : null}
                          </Toggle>
                          {shipQueueSupported ? (
                            <Toggle value="ship-queue">
                              <T>Ship Queue</T>
                              {shipQueueCount > 0 ? (
                                <span className="text-2xs text-muted-foreground tabular-nums">
                                  {shipQueueCount}
                                </span>
                              ) : null}
                            </Toggle>
                          ) : null}
                          <Toggle value="servers">
                            <T>Servers</T>
                          </Toggle>
                        </ToggleGroup>
                      ) : null}
                    </div>

                    {!selectedConnected ? (
                      <div className="rounded-xl border border-border/70 bg-card">
                        <Empty>
                          <EmptyMedia variant="icon">
                            <ServerIcon />
                          </EmptyMedia>
                          <EmptyHeader>
                            <EmptyTitle>
                              <T>
                                <Var>{selectedEnvironment.label}</Var> is not connected
                              </T>
                            </EmptyTitle>
                            <EmptyDescription>
                              {connectionStatusTitle(selectedEnvironment.connection, messages)}
                            </EmptyDescription>
                          </EmptyHeader>
                          <Button
                            variant="outline"
                            size="sm"
                            render={<Link to="/settings/connections" />}
                          >
                            <T>Open connections</T>
                          </Button>
                        </Empty>
                      </div>
                    ) : (
                      <RenderErrorBoundary
                        resetKeys={[selectedEnvironment.environmentId, tab]}
                        fallback={
                          <div className="rounded-xl border border-border/70 bg-card">
                            <Empty size="compact">
                              <EmptyMedia variant="icon">
                                <AlertTriangleIcon />
                              </EmptyMedia>
                              <EmptyHeader>
                                <EmptyTitle>
                                  <T>Unable to display machine view</T>
                                </EmptyTitle>
                                <EmptyDescription>
                                  <T>
                                    Try refreshing or switching tabs to reload diagnostics for this
                                    machine.
                                  </T>
                                </EmptyDescription>
                              </EmptyHeader>
                            </Empty>
                          </div>
                        }
                      >
                        {activeTab === "overview" ? (
                          <div className="flex flex-col gap-4">
                            <MachineTelemetryCards
                              key={selectedEnvironment.environmentId}
                              environmentId={selectedEnvironment.environmentId}
                            />
                            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                              <MachineThreadsPanel
                                key={`threads:${selectedEnvironment.environmentId}`}
                                environmentId={selectedEnvironment.environmentId}
                              />
                              <MachineServersPanel
                                key={`servers:${selectedEnvironment.environmentId}`}
                                environmentId={selectedEnvironment.environmentId}
                              />
                            </div>
                          </div>
                        ) : activeTab === "processes" ? (
                          !diagnosticsAccess.canReadDiagnostics && !diagnosticsAccess.isPending ? (
                            <div className="rounded-xl border border-border/70 bg-card">
                              <Empty size="compact">
                                <EmptyMedia variant="icon">
                                  <ServerIcon />
                                </EmptyMedia>
                                <EmptyHeader>
                                  <EmptyTitle>
                                    <T>Process telemetry unavailable</T>
                                  </EmptyTitle>
                                  <EmptyDescription>{diagnosticsAccess.error}</EmptyDescription>
                                </EmptyHeader>
                              </Empty>
                            </div>
                          ) : (
                            <ResourceTelemetryDiagnostics
                              key={selectedEnvironment.environmentId}
                              environmentId={selectedEnvironment.environmentId}
                            />
                          )
                        ) : activeTab === "jobs" ? (
                          <MachineJobsPanel
                            key={`jobs:${selectedEnvironment.environmentId}`}
                            environmentId={selectedEnvironment.environmentId}
                          />
                        ) : activeTab === "ship-queue" && shipQueueSupported ? (
                          <MachineShipQueuePanel
                            key={`ship-queue:${selectedEnvironment.environmentId}`}
                            environmentId={selectedEnvironment.environmentId}
                          />
                        ) : (
                          <MachineServersPanel
                            key={selectedEnvironment.environmentId}
                            environmentId={selectedEnvironment.environmentId}
                          />
                        )}
                      </RenderErrorBoundary>
                    )}
                  </div>
                ) : null}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
