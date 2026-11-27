import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** A thread that holds a device on a host, as a refused open reports it. */
export const DeviceLeaseHolder = Schema.Struct({
  threadId: ThreadId,
  deviceId: Schema.String,
  heldSince: Schema.String,
  expiresAt: Schema.String,
});
export type DeviceLeaseHolder = typeof DeviceLeaseHolder.Type;

/**
 * An open refused because another thread holds the device (`held`), or because the host
 * already runs its maximum number of leased emulators (`host_limit`).
 */
export class DeviceLeaseUnavailableError extends Schema.TaggedError<DeviceLeaseUnavailableError>()(
  "DeviceLeaseUnavailableError",
  {
    hostId: Schema.String,
    deviceId: Schema.String,
    reason: Schema.Literals(["held", "host_limit"]),
    holders: Schema.Array(DeviceLeaseHolder),
    limit: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    const names = this.holders.map((holder) => `thread ${holder.threadId}`).join(", ");
    if (this.reason === "host_limit")
      return `Host ${this.hostId} already runs ${this.limit ?? this.holders.length} leased emulators (${names}). Close one, then retry.`;
    const holder = this.holders[0];
    return `Device ${this.deviceId} on host ${this.hostId} is leased to ${names}${holder ? ` until ${holder.expiresAt} unless it renews` : ""}. Open another device or close it in that thread.`;
  }
}
