// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Bounded async action tracker for Fleet Console mutations (check/ci/provision/server/session).
import * as NodeCrypto from "node:crypto";

import type { FleetAction } from "./FleetTypes.ts";

const MAX_ACTIONS = 200;

export class FleetActionTracker {
  private readonly byId = new Map<string, FleetAction>();
  private readonly order: string[] = [];
  private readonly onEvent: (act: FleetAction) => void;

  constructor(onEvent: (act: FleetAction) => void) {
    this.onEvent = onEvent;
  }

  get(id: string): FleetAction | null {
    return this.byId.get(id) ?? null;
  }

  start(
    kind: string,
    target: string,
    runner: (
      onProgress: (msg: string) => void,
    ) => Promise<{ readonly ok: boolean; readonly message: string }>,
  ): string {
    const id = NodeCrypto.randomBytes(8).toString("hex");
    const act: FleetAction = {
      id,
      kind,
      target,
      state: "running",
      message: "",
      at: new Date().toISOString(),
    };
    this.byId.set(id, act);
    this.order.push(id);
    if (this.order.length > MAX_ACTIONS) {
      const old = this.order.shift();
      if (old) this.byId.delete(old);
    }
    this.onEvent(act);

    void runner((msg) => {
      const updated: FleetAction = {
        ...act,
        state: "running",
        message: msg,
        at: new Date().toISOString(),
      };
      this.byId.set(id, updated);
      this.onEvent(updated);
    })
      .then((res) => {
        const done: FleetAction = {
          ...act,
          state: res.ok ? "ok" : "failed",
          message: res.message,
          at: new Date().toISOString(),
        };
        this.byId.set(id, done);
        this.onEvent(done);
      })
      .catch((err: unknown) => {
        const failed: FleetAction = {
          ...act,
          state: "failed",
          message: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        };
        this.byId.set(id, failed);
        this.onEvent(failed);
      });

    return id;
  }
}
