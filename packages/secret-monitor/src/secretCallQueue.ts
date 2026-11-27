import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import type { SecretCall } from "./secretMessages.ts";

/** Calls other than GetSecrets that may wait for resolution at once. */
const DEFAULT_CHEAP_CALL_BUDGET = 1024;

export interface QueuedSecretCall {
  readonly call: SecretCall;
  /** Audit calls dropped since the previous take; the consumer records them. */
  readonly dropped: number;
}

/**
 * Buffers classified calls between the bus listener and the handler. GetSecrets is never
 * dropped. Audit calls share a bounded budget, and each one refused is counted so the log says
 * how many went unrecorded. Routine calls only prime the sender cache, so one pending per sender
 * is enough, and one refused for lack of budget loses no audit entry.
 */
export const makeSecretCallQueue = Effect.fn("SecretMonitor.makeSecretCallQueue")(function* (
  cheapBudget: number = DEFAULT_CHEAP_CALL_BUDGET,
) {
  const queue = yield* Queue.unbounded<SecretCall>();
  const primingSenders = new Set<string>();
  let cheapPending = 0;
  let dropped = 0;

  /** Called synchronously from the bus listener. */
  const offer = (call: SecretCall): void => {
    if (call.kind === "getSecrets") {
      Queue.offerUnsafe(queue, call);
      return;
    }
    if (call.kind === "routine") {
      if (call.sender === undefined || primingSenders.has(call.sender)) return;
      if (cheapPending >= cheapBudget) return;
      primingSenders.add(call.sender);
    } else if (cheapPending >= cheapBudget) {
      dropped += 1;
      return;
    }
    cheapPending += 1;
    Queue.offerUnsafe(queue, call);
  };

  const take = Queue.take(queue).pipe(
    Effect.map((call): QueuedSecretCall => {
      if (call.kind !== "getSecrets") cheapPending -= 1;
      if (call.kind === "routine" && call.sender !== undefined) {
        primingSenders.delete(call.sender);
      }
      const report = dropped;
      dropped = 0;
      return { call, dropped: report };
    }),
  );

  return { offer, take } as const;
});
