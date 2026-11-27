/**
 * Minimal integration seam for T3 Code:
 *   - `<DevtoolsSidebarItems />` in `SidebarChrome.tsx` (Tall-Ship icon opening Fleet Console)
 *   - `<DevtoolsOverlayHost />` in `__root.tsx` (background watcher for thread-native DevTools approvals)
 *   - `<DevtoolsWorkspaceOutlet />` in `__root.tsx` (fullscreen Fleet Console: Machines | Reaper & Sweep)
 */
import { useEffect, useState, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { HardDriveIcon, RefreshCwIcon, ServerIcon, SettingsIcon, XIcon } from "lucide-react";

import "./fleetDeck.css";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import {
  SidebarInset,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { mergeFleetHosts } from "./devdeckTypes";
import { DevtoolsApprovalWatcher } from "./DevtoolsApprovalWatcher";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import {
  closeFleetConsole,
  setConsoleHost,
  setConsoleSection,
  toggleFleetConsole,
  useDevtoolsSelector,
  type ConsoleActionFeedback,
  type FleetConsoleSection,
} from "./devtoolsStore";
import { refreshSharedDevdeck, useSharedCapabilities, useSharedDevdeck } from "./devtoolsStreams";
import { FleetMachinesView } from "./FleetMachinesView";
import { FleetReaperTab } from "./FleetReaperTab";
import { refreshSharedJobs, useSharedJobs } from "./jobs/jobsStore";
import { isHostJob } from "./jobs/jobTypes";
import { TallShipIcon } from "./TallShipIcon";

const OPEN_OVERLAY_SELECTOR =
  "[role='menu'], [data-slot='menu-popup'], [data-slot='popover-popup'], [data-slot='dialog-popup'], [role='dialog'], [role='alertdialog'], [data-slot='select-popup']";

export function DevtoolsSidebarItems() {
  const gt = useGT();
  const consoleOpen = useDevtoolsSelector((s) => s.consoleOpen);
  const { isMobile, setOpenMobile } = useSidebar();

  const handleToggle = () => {
    if (isMobile) setOpenMobile(false);
    toggleFleetConsole();
  };

  return (
    <SidebarMenuItem className="relative shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={gt("Fleet Console", {
                $context: "sidebar button opening the unified fleet console",
              })}
              data-active={consoleOpen}
              data-devtools-console-trigger=""
              onClick={handleToggle}
              size="icon"
            >
              <TallShipIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">
          <T>Fleet Console (Machines · Reaper)</T>
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

function FleetConsoleBody({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const section = useDevtoolsSelector((s) => s.consoleSection);
  const selectedHostId = useDevtoolsSelector((s) => s.selectedHost);
  const selectedJobId = useDevtoolsSelector((s) => s.selectedJobId);

  const capsState = useSharedCapabilities(environmentId);
  const devdeckState = useSharedDevdeck(environmentId, "active");
  const jobsState = useSharedJobs(environmentId);
  const [feedback, setFeedback] = useState<ConsoleActionFeedback | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const panels = devdeckState.panels;
  const mergedHosts = mergeFleetHosts({
    localHost: panels?.host ?? null,
    localServers: panels?.servers ?? [],
    localSessions: panels?.sessions ?? [],
    localAlerts: [],
    localWorktrees: panels?.worktrees ?? null,
    nodes: panels?.nodes ?? {},
    hostsReport: panels?.hosts ?? null,
    shipPanel: panels?.ship ?? null,
  });

  const selectedHost =
    mergedHosts.find((h) => h.id === selectedHostId || h.probeHostName === selectedHostId) ??
    mergedHosts[0] ??
    null;

  const hostJobs = jobsState.jobs.filter(isHostJob);
  const onlineHostCount = mergedHosts.filter((h) => h.status !== "offline").length;
  const degradedHostCount = mergedHosts.filter((h) => h.status !== "online").length;

  const handleGlobalRefresh = async () => {
    setRefreshing(true);
    setFeedback({ tone: "busy", text: gt("Refreshing fleet telemetry…") });
    await Promise.all([refreshSharedDevdeck(environmentId), refreshSharedJobs(environmentId)]);
    setRefreshing(false);
    setFeedback({ tone: "ok", text: gt("Fleet telemetry refreshed") });
  };

  const hostIdsKey = mergedHosts.map((h) => h.id).join("\0");
  const selectedId = selectedHost?.id ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- [ / ] hotkeys to cycle machines on Machines tab
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) {
        return;
      }
      if ((event.key === "[" || event.key === "]") && section === "machines" && hostIdsKey) {
        const ids = hostIdsKey.split("\0");
        if (ids.length < 2) return;
        event.preventDefault();
        const curIdx = Math.max(0, selectedId ? ids.indexOf(selectedId) : 0);
        const nextIdx =
          event.key === "]" ? (curIdx + 1) % ids.length : (curIdx - 1 + ids.length) % ids.length;
        const target = ids[nextIdx];
        if (target) setConsoleHost(target);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [section, hostIdsKey, selectedId]);

  const navItems: ReadonlyArray<{
    readonly id: FleetConsoleSection;
    readonly label: string;
    readonly icon: typeof ServerIcon;
    readonly badge?: string | undefined;
    readonly badgeTone?: "warn" | undefined;
  }> = [
    {
      id: "machines",
      label: gt("Machines"),
      icon: ServerIcon,
      badge: mergedHosts.length > 0 ? `${onlineHostCount}/${mergedHosts.length}` : undefined,
      badgeTone: degradedHostCount > 0 ? "warn" : undefined,
    },
    {
      id: "reaper",
      label: gt("Reaper & Sweep"),
      icon: HardDriveIcon,
    },
  ];

  return (
    <div data-fd="root" className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <WorkspacePageHeader
        electron={isElectron}
        reserveNativeControls
        className="relative justify-between border-b bg-background"
      >
        <div className="flex min-w-0 items-center gap-3 [-webkit-app-region:no-drag]">
          <div className="flex items-center gap-2">
            <TallShipIcon className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-sm font-semibold leading-none">
              <T>Fleet Console</T>
            </h1>
          </div>

          <div data-fd="views" role="tablist" aria-label={gt("Fleet Console views")}>
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-fd="view-btn"
                  data-active={active}
                  onClick={() => setConsoleSection(item.id)}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span>{item.label}</span>
                  {item.badge ? (
                    <span data-fd="view-count" data-tone={item.badgeTone}>
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div
          className="relative flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
          data-workspace-titlebar-controls
        >
          {feedback ? (
            <span
              className={
                feedback.tone === "error"
                  ? "mr-2 max-w-64 truncate text-2xs text-destructive"
                  : "mr-2 max-w-64 truncate text-2xs text-muted-foreground"
              }
            >
              {feedback.text}
            </span>
          ) : null}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={refreshing}
                  aria-label={gt("Refresh fleet telemetry")}
                  onClick={() => void handleGlobalRefresh()}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              <T>Refresh telemetry</T>
            </TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={gt("DevTools settings")}
                  onClick={() => {
                    closeFleetConsole();
                    void navigate({ to: "/settings/devtools" });
                  }}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              <T>DevTools Settings</T>
            </TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={gt("Close Fleet Console")}
                  onClick={() => closeFleetConsole()}
                >
                  <XIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              <T>Close (Esc)</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      </WorkspacePageHeader>

      {section === "reaper" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DevtoolsErrorBoundary panelName="Reaper & Sweep" resetKeys={[environmentId, section]}>
            <FleetReaperTab
              environmentId={environmentId}
              localHostName={panels?.host?.name ?? capsState.capabilities?.host ?? "local"}
              selectedHostName={selectedHost?.shortName ?? null}
              isSelectedHostLocal={selectedHost ? selectedHost.isLocal : true}
              mergedWorktreesCount={panels?.worktrees?.merged ?? 0}
              onFeedback={setFeedback}
            />
          </DevtoolsErrorBoundary>
        </div>
      ) : (
        <DevtoolsErrorBoundary
          panelName="Fleet Machines"
          resetKeys={[environmentId, selectedHost?.id ?? null]}
        >
          <FleetMachinesView
            environmentId={environmentId}
            hosts={mergedHosts}
            selectedHost={selectedHost}
            hostJobs={hostJobs}
            selectedJobId={selectedJobId}
            devdeckStatus={devdeckState.status}
            devdeckError={devdeckState.error}
            onFeedback={setFeedback}
          />
        </DevtoolsErrorBoundary>
      )}
    </div>
  );
}

function FleetConsoleView() {
  const gt = useGT();
  const currentHref = useLocation({ select: (loc) => loc.href });
  const [openedHref] = useState(currentHref);
  const selectedEnvId = useDevtoolsSelector((s) => s.selectedEnvId);
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  const connectedSet = new Set(connectedIds);
  const primaryEnvId = usePrimaryEnvironmentId();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes Fleet Console on navigation
  useEffect(() => {
    if (currentHref !== openedHref) closeFleetConsole();
  }, [currentHref, openedHref]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes Fleet Console on sidebar thread/link clicks
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const sidebar = target.closest("[data-app-sidebar]");
      if (!sidebar || target.closest("[data-devtools-console-trigger]")) return;
      if (target.closest("[aria-haspopup], [role='menu'], [role='menuitem']")) return;
      if (target.closest("[data-thread-item], a[href]")) closeFleetConsole();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes Fleet Console on Escape
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) {
        return;
      }
      event.preventDefault();
      closeFleetConsole();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectedCaps = useSharedCapabilities(selectedEnvId);
  const preferredPrimary =
    (primaryEnvId && connectedSet.has(primaryEnvId) ? primaryEnvId : null) ??
    environments.find((e) => connectedSet.has(e.environmentId))?.environmentId ??
    primaryEnvId ??
    environments[0]?.environmentId ??
    null;

  const effectiveEnvId =
    selectedEnvId &&
    connectedSet.has(selectedEnvId) &&
    !selectedCaps.unsupported &&
    environments.some((e) => e.environmentId === selectedEnvId)
      ? selectedEnvId
      : preferredPrimary;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {effectiveEnvId === null ? (
        <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls
            className="relative justify-between border-b bg-background"
          >
            <div className="flex min-w-0 items-center gap-2 [-webkit-app-region:no-drag]">
              <TallShipIcon className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="truncate text-sm font-semibold leading-none">
                <T>Fleet Console</T>
              </h1>
            </div>
            <div className="[-webkit-app-region:no-drag]" data-workspace-titlebar-controls>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={gt("Close Fleet Console")}
                onClick={() => closeFleetConsole()}
              >
                <XIcon />
              </Button>
            </div>
          </WorkspacePageHeader>
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
            <T>No connected environment.</T>
          </div>
        </div>
      ) : (
        <DevtoolsErrorBoundary panelName="Fleet Console" resetKeys={[effectiveEnvId]}>
          <FleetConsoleBody key={effectiveEnvId} environmentId={effectiveEnvId} />
        </DevtoolsErrorBoundary>
      )}
    </SidebarInset>
  );
}

export function DevtoolsWorkspaceOutlet({ children }: { readonly children: ReactNode }) {
  const consoleOpen = useDevtoolsSelector((s) => s.consoleOpen);
  if (consoleOpen) {
    return <FleetConsoleView />;
  }
  return children;
}

export function DevtoolsOverlayHost() {
  return (
    <DevtoolsErrorBoundary panelName="DevTools Approval Watcher" compact floating>
      <DevtoolsApprovalWatcher />
    </DevtoolsErrorBoundary>
  );
}
