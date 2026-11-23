import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { T } from "gt-react";
import { useEffect, useState } from "react";

import { BackgroundWorkTaskSection } from "../jobs/BackgroundWorkInspector";
import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

export function BackgroundWorkDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll 5s clock while background work dialog is open
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<InlineButton />}>
        <T>Details</T>
      </DialogTrigger>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Background work</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {props.tasks.map((task) => (
              <BackgroundWorkTaskSection
                key={task.taskId}
                environmentId={props.environmentId}
                threadId={props.threadId}
                task={task}
                turnItems={props.turnItems}
                nowMs={nowMs}
                onOpenThread={(childThreadId) => {
                  setOpen(false);
                  props.onOpenThread(childThreadId);
                }}
              />
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
