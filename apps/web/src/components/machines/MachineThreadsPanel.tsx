import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { cn } from "../../lib/utils";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { selectEnvironmentThreads } from "./machines.logic";

const PAGE_SIZE = 12;

function statusDotClassName(status: SidebarThreadStatus): string {
  switch (status) {
    case "preparing":
    case "working":
      return "bg-info";
    case "approval":
    case "limited":
      return "bg-warning";
    case "input":
      return "bg-indigo-500";
    case "request":
      return "bg-guest";
    case "failed":
      return "bg-destructive";
    case "waiting":
    case "ready":
      return "bg-muted-foreground/45";
  }
}

function statusLabel(status: SidebarThreadStatus, gt: ReturnType<typeof useGT>): string | null {
  switch (status) {
    case "preparing":
      return gt("Setting up");
    case "working":
      return gt("Working", { $context: "thread status" });
    case "approval":
      return gt("Approval", { $context: "thread status: needs approval" });
    case "input":
      return gt("Input", { $context: "thread status: needs user input" });
    case "request":
      return gt("Request", { $context: "thread status: guest request" });
    case "limited":
      return gt("Limited", { $context: "thread status: usage limited" });
    case "failed":
      return gt("Failed", { $context: "thread status" });
    case "waiting":
      return gt("Waiting", { $context: "thread status" });
    case "ready":
      return null;
  }
}

function statusTextClassName(status: SidebarThreadStatus): string {
  switch (status) {
    case "preparing":
    case "working":
      return "text-info-foreground";
    case "approval":
    case "limited":
      return "text-warning-foreground";
    case "input":
      return "text-indigo-600 dark:text-indigo-300";
    case "request":
      return "text-guest-foreground";
    case "failed":
      return "text-error-foreground";
    case "waiting":
    case "ready":
      return "text-muted-foreground";
  }
}

function ThreadTimestamp({ timestamp }: { readonly timestamp: string }) {
  const relative = useRelativeTimeState(timestamp);
  if (relative.status !== "relative") return null;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value}
    </span>
  );
}

export function MachineThreadsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const navigate = useNavigate();
  const allThreads = useVisibleThreadShells();
  const projects = useProjects();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const projectNames = new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project.title,
    ]),
  );
  const threads = selectEnvironmentThreads(allThreads, environmentId);
  const shown = threads.slice(0, visibleCount);
  const remaining = Math.max(0, threads.length - shown.length);

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">
            <T>Threads</T>
          </h2>
          <Badge size="sm" variant="secondary">
            {threads.length}
          </Badge>
        </div>
      </div>

      {threads.length === 0 ? (
        <Empty size="compact">
          <EmptyMedia variant="icon">
            <MessageSquareIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>
              <T>No active threads</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Active and recent threads running on this machine appear here.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <ul className="m-0 divide-y divide-border/50 p-0">
            {shown.map((thread) => {
              const status = resolveSidebarThreadStatus(thread);
              const badgeText = statusLabel(status, gt);
              const projectName =
                projectNames.get(
                  scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
                ) ?? null;
              const subtitle = [projectName, thread.branch].filter(Boolean).join(" · ");
              return (
                <li key={thread.id} className="list-none">
                  <button
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId: thread.environmentId, threadId: thread.id },
                      })
                    }
                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span
                        aria-hidden
                        className={cn("size-2 shrink-0 rounded-full", statusDotClassName(status))}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {thread.title}
                        </span>
                        {subtitle ? (
                          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {badgeText ? (
                        <span className={cn("text-xs font-medium", statusTextClassName(status))}>
                          {badgeText}
                        </span>
                      ) : null}
                      <ThreadTimestamp timestamp={thread.updatedAt} />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          {remaining > 0 ? (
            <div className="border-t border-border/60 px-4 py-2">
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
              >
                <ChevronDownIcon aria-hidden />
                <T>
                  Show <Var>{Math.min(remaining, PAGE_SIZE)}</Var> more
                </T>
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
