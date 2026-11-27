import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeSecretCallQueue } from "./secretCallQueue.ts";
import type { SecretCall } from "./secretMessages.ts";

const read = (sender: string): SecretCall => ({
  kind: "getSecrets",
  sender,
  interface: "org.freedesktop.Secret.Service",
  paths: ["/item"],
});
const audit = (sender: string): SecretCall => ({
  kind: "audit",
  sender,
  interface: "org.freedesktop.Secret.Service",
  member: "SearchItems",
});
const routine = (sender: string): SecretCall => ({ kind: "routine", sender });

describe("makeSecretCallQueue", () => {
  it.effect("keeps every GetSecrets through an audit flood and counts the audits dropped", () =>
    Effect.gen(function* () {
      const queue = yield* makeSecretCallQueue(2);
      queue.offer(audit(":1.1"));
      queue.offer(audit(":1.2"));
      for (let index = 0; index < 10; index += 1) queue.offer(audit(`:1.flood${index}`));
      queue.offer(read(":1.reader"));
      queue.offer(read(":1.reader"));

      const taken = [];
      for (let index = 0; index < 4; index += 1) taken.push(yield* queue.take);
      expect(taken.map(({ call }) => [call.kind, call.sender])).toEqual([
        ["audit", ":1.1"],
        ["audit", ":1.2"],
        ["getSecrets", ":1.reader"],
        ["getSecrets", ":1.reader"],
      ]);
      expect(taken.map(({ dropped }) => dropped)).toEqual([10, 0, 0, 0]);
    }),
  );

  it.effect("frees budget as calls are taken", () =>
    Effect.gen(function* () {
      const queue = yield* makeSecretCallQueue(1);
      queue.offer(audit(":1.1"));
      queue.offer(audit(":1.2"));
      expect(yield* queue.take).toEqual({ call: audit(":1.1"), dropped: 1 });
      queue.offer(audit(":1.3"));
      expect(yield* queue.take).toEqual({ call: audit(":1.3"), dropped: 0 });
    }),
  );

  it.effect("primes each sender once and never counts a skipped prime as a drop", () =>
    Effect.gen(function* () {
      const queue = yield* makeSecretCallQueue(2);
      queue.offer(routine(":1.1"));
      queue.offer(routine(":1.1"));
      queue.offer({ kind: "routine", sender: undefined });
      queue.offer(routine(":1.2"));
      queue.offer(routine(":1.3"));
      queue.offer(read(":1.1"));

      const taken = [];
      for (let index = 0; index < 3; index += 1) taken.push(yield* queue.take);
      expect(taken).toEqual([
        { call: routine(":1.1"), dropped: 0 },
        { call: routine(":1.2"), dropped: 0 },
        { call: read(":1.1"), dropped: 0 },
      ]);
      // Taken, so the sender may be primed again by a later session.
      queue.offer(routine(":1.1"));
      expect(yield* queue.take).toEqual({ call: routine(":1.1"), dropped: 0 });
    }),
  );
});
