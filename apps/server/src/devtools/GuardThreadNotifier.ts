import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { GuardThreadNotice } from "./GuardThreadNotice.ts";

/**
 * Sends a guard decision into the requesting thread as a queued message, so an idle agent wakes
 * with what to re-run. Without thread management (tests, headless tools) it stays off.
 */
export const makeGuardThreadNotifier = Effect.fn("GuardThreadNotifier.make")(function* () {
  const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
  if (Option.isNone(threads)) return undefined;
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  const send = Effect.fn("GuardThreadNotifier.send")(function* (notice: GuardThreadNotice) {
    const threadId = ThreadId.make(notice.threadId);
    const shell = yield* threads.value.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) return;
    const id = `guard-decision:${notice.requestId}:${notice.decision}`;
    yield* threads.value.sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(id),
      text: notice.text,
      attachments: [],
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
  });
  return (notice: GuardThreadNotice): void => {
    runFork(
      send(notice).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Guard decision notice was not delivered", {
            threadId: notice.threadId,
            cause,
          }),
        ),
      ),
    );
  };
});
