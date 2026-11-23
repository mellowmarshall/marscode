import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { CableIcon, ChevronDownIcon, ExternalLinkIcon, GlobeIcon, SquareIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import {
  resolveExternalServerUrl,
  tunnelsEnvironmentLoopback,
} from "../../browser/browserTargetResolver";
import { m } from "../../i18n/messages";
import { isMacPlatform } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useDiscoveredPortsState } from "../../portDiscoveryState";
import { useVisibleThreadShells } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import {
  canForwardPorts,
  findPortForward,
  forwardedUrl,
  forwardPort,
  stopPortForward,
  useForwardLocality,
  usePortForwards,
} from "../../state/portForwards";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SERVER_PAGE_SIZE = 8;

function serverKey(server: DiscoveredLocalServer): string {
  return `${server.pid ?? "none"}:${server.port}`;
}

function attributedThreadId(server: DiscoveredLocalServer): ThreadId | null {
  return server.terminal?.threadId ?? server.agent?.threadId ?? null;
}

export function MachineServersPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const { servers } = useDiscoveredPortsState(environmentId);
  const threads = useVisibleThreadShells();
  const environment = useEnvironment(environmentId);
  const canOpen = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(previewEnvironment.stopLocalServer.permissionAtom(environmentId));
  const supportsStop = environment?.serverConfig?.environment.capabilities.localServerStop === true;
  const forwards = usePortForwards();
  const forwardable =
    useEnvironmentScope(environmentId, AuthTerminalOperateScope) &&
    environment?.connection.phase === "connected" &&
    canForwardPorts(environment);
  const locality = useForwardLocality(forwardable ? environmentId : null);
  const canForward = locality === "remote";
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    reportFailure: false,
  });

  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const [forwardingPort, setForwardingPort] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(SERVER_PAGE_SIZE);
  const shown = servers.slice(0, visibleCount);
  const remaining = Math.max(0, servers.length - shown.length);

  const threadById = new Map(
    threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => [thread.id, thread]),
  );
  const externalClickLabel = isMacPlatform(navigator.platform) ? "⌘-click" : "Ctrl-click";

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? String(error),
      }),
    );
  };

  const openExternal = async (server: DiscoveredLocalServer) => {
    const forwarding = forwardable && locality !== "local";
    const url = forwarding
      ? await forwardPort(environmentId, server.port).then(
          (forward) => forwardedUrl(forward, server.url),
          (error: unknown) => {
            reportFailure(gt("Could not forward port {port}", { port: server.port }), error);
            return null;
          },
        )
      : resolveExternalServerUrl(environmentId, server.url);
    if (url === null) return;
    if (
      !forwarding &&
      locality !== "local" &&
      tunnelsEnvironmentLoopback(environment?.entry.target) &&
      isLoopbackHost(new URL(url).hostname)
    ) {
      reportFailure(
        gt("Unable to open in browser"),
        new Error(
          gt(
            "localhost:{port} runs on another machine, and port forwarding isn't available for it right now.",
            { port: server.port },
          ),
        ),
      );
      return;
    }
    const api = readLocalApi();
    if (api) {
      await api.shell
        .openExternal(url)
        .catch((error: unknown) => reportFailure(gt("Unable to open in browser"), error));
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleOpen = async (server: DiscoveredLocalServer, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    const threadId = attributedThreadId(server);
    if (threadId === null || event.metaKey || event.ctrlKey || event.button === 1) {
      event.preventDefault();
      await openExternal(server);
      return;
    }
    const threadRef = scopeThreadRef(environmentId, threadId);
    const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Unable to open preview"), squashAtomCommandFailure(result));
      }
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };

  const handleStop = (server: DiscoveredLocalServer) => {
    if (server.pid === null || stoppingKey !== null) return;
    setStoppingKey(serverKey(server));
    void stopServer({
      environmentId,
      input: { pid: server.pid, port: server.port },
    })
      .then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportFailure(gt("Could not stop server"), squashAtomCommandFailure(result));
        }
      })
      .finally(() => {
        setStoppingKey(null);
      });
  };

  const handleToggleForward = (server: DiscoveredLocalServer, forwarded: boolean) => {
    if (forwardingPort !== null) return;
    setForwardingPort(server.port);
    void (
      forwarded
        ? stopPortForward(environmentId, server.port)
        : forwardPort(environmentId, server.port)
    )
      .catch((error: unknown) => {
        reportFailure(gt("Could not forward port {port}", { port: server.port }), error);
      })
      .finally(() => {
        setForwardingPort(null);
      });
  };

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">
            <T>Local servers</T>
          </h2>
          <Badge size="sm" variant="secondary">
            {servers.length}
          </Badge>
        </div>
      </div>

      {servers.length === 0 ? (
        <Empty size="compact">
          <EmptyMedia variant="icon">
            <GlobeIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>
              <T>No local servers</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Dev servers started in terminals or by agents on this machine appear here.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <ul className="m-0 divide-y divide-border/50 p-0">
            {shown.map((server) => {
              const key = serverKey(server);
              const threadId = attributedThreadId(server);
              const thread = threadId ? (threadById.get(threadId) ?? null) : null;
              const forward = findPortForward(forwards, environmentId, server.port);
              const stoppable = canStop && supportsStop && server.pid !== null;
              const metaParts = [
                forward
                  ? gt("Forwarded to :{port}", {
                      $context: "a remote dev server reachable on this machine's port",
                      port: forward.localPort,
                    })
                  : null,
                server.terminal === null
                  ? gt("Agent", { $context: "who started a dev server" })
                  : gt("Terminal", { $context: "who started a dev server" }),
                server.processName,
                server.pid !== null ? gt("PID {pid}", { pid: server.pid }) : null,
              ].filter(Boolean);

              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <GlobeIcon
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium text-foreground">
                          localhost:{server.port}
                        </span>
                        {thread ? (
                          <button
                            type="button"
                            onClick={() =>
                              void navigate({
                                to: "/$environmentId/$threadId",
                                params: { environmentId, threadId: thread.id },
                              })
                            }
                            className="max-w-48 cursor-pointer truncate rounded-sm text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            {thread.title}
                          </button>
                        ) : null}
                      </div>
                      <span className="truncate text-xs text-muted-foreground">
                        {metaParts.join(" · ")}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!canOpen && threadId !== null}
                            onClick={(event) => void handleOpen(server, event)}
                            onAuxClick={(event) => void handleOpen(server, event)}
                          >
                            <ExternalLinkIcon aria-hidden />
                            <T>Open</T>
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">
                        {threadId ? (
                          <T>
                            Open in the thread browser. <Var>{externalClickLabel}</Var> for your
                            browser.
                          </T>
                        ) : (
                          <T>Open in your browser</T>
                        )}
                      </TooltipPopup>
                    </Tooltip>

                    {canForward ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant={forward ? "secondary" : "ghost-muted"}
                              aria-pressed={forward !== undefined}
                              aria-label={
                                forward
                                  ? gt("Stop forwarding localhost:{port}", { port: server.port })
                                  : gt("Forward localhost:{port} to this machine", {
                                      port: server.port,
                                    })
                              }
                              disabled={forwardingPort !== null}
                              onClick={() => handleToggleForward(server, forward !== undefined)}
                            >
                              {forwardingPort === server.port ? (
                                <Spinner aria-hidden size="xs" />
                              ) : (
                                <CableIcon aria-hidden />
                              )}
                            </Button>
                          }
                        />
                        <TooltipPopup side="top">
                          {forward ? (
                            <T>
                              Forwarded to localhost:<Var>{forward.localPort}</Var> on this machine.
                              Click to stop.
                            </T>
                          ) : (
                            <T>Forward to this machine</T>
                          )}
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}

                    {stoppable ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost-destructive"
                              aria-label={gt("Stop localhost:{port}", { port: server.port })}
                              disabled={stoppingKey !== null}
                              onClick={() => handleStop(server)}
                            >
                              {stoppingKey === key ? (
                                <Spinner aria-hidden size="xs" />
                              ) : (
                                <SquareIcon className="size-2.5 fill-current" aria-hidden />
                              )}
                            </Button>
                          }
                        />
                        <TooltipPopup side="top">
                          <T>Stop server</T>
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {remaining > 0 ? (
            <div className="border-t border-border/60 px-4 py-2">
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => setVisibleCount((prev) => prev + SERVER_PAGE_SIZE)}
              >
                <ChevronDownIcon aria-hidden />
                <T>
                  Show <Var>{Math.min(remaining, SERVER_PAGE_SIZE)}</Var> more
                </T>
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
