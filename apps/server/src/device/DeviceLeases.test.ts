import { describe, expect, it } from "@effect/vitest";
import { DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  DEFAULT_DEVICE_LEASE_OPTIONS,
  deviceLeaseOptions,
  MAX_DEVICE_LEASE_TTL_SECONDS,
  MAX_LOCAL_EMULATORS,
  makeDeviceLeases,
  readOnlyEmulatorArgs,
} from "./DeviceLeases.ts";

const a = ThreadId.make("thread-a");
const b = ThreadId.make("thread-b");
const avd = DeviceId.make("Pixel_API_35");
const serial = DeviceId.make("emulator-5554");
const request = (threadId: ThreadId, deviceId = avd) => ({
  threadId,
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId,
  emulator: true,
});
const session = (threadId: ThreadId, deviceId: DeviceId) => ({
  threadId,
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId,
  platform: "android" as const,
  openedAt: "1970-01-01T00:00:00.000Z",
});

describe("deviceLeaseOptions", () => {
  it("reads the TTL and local emulator cap, ignoring values that are not positive integers", () => {
    expect(deviceLeaseOptions({})).toEqual({
      ttl: DEFAULT_DEVICE_LEASE_OPTIONS.ttl,
      maxLocalEmulators: undefined,
    });
    expect(
      deviceLeaseOptions({
        T3CODE_DEVICE_LEASE_TTL_SECONDS: "90",
        T3CODE_DEVICE_MAX_LOCAL_EMULATORS: "3",
      }),
    ).toEqual({ ttl: Duration.seconds(90), maxLocalEmulators: 3 });
    expect(
      deviceLeaseOptions({
        T3CODE_DEVICE_LEASE_TTL_SECONDS: "-1",
        T3CODE_DEVICE_MAX_LOCAL_EMULATORS: "1.5",
      }).maxLocalEmulators,
    ).toBeUndefined();
  });

  it("clamps huge values so a lease's expiry stays a valid date", () => {
    const options = deviceLeaseOptions({
      T3CODE_DEVICE_LEASE_TTL_SECONDS: "1e20",
      T3CODE_DEVICE_MAX_LOCAL_EMULATORS: "1e20",
    });
    expect(options).toEqual({
      ttl: Duration.seconds(MAX_DEVICE_LEASE_TTL_SECONDS),
      maxLocalEmulators: MAX_LOCAL_EMULATORS,
    });
    // Not finite integers, so they fall back to the defaults rather than clamp.
    for (const value of ["Infinity", "NaN", "0", "abc", "9".repeat(400)])
      expect(
        deviceLeaseOptions({
          T3CODE_DEVICE_LEASE_TTL_SECONDS: value,
          T3CODE_DEVICE_MAX_LOCAL_EMULATORS: value,
        }),
      ).toEqual({ ttl: DEFAULT_DEVICE_LEASE_OPTIONS.ttl, maxLocalEmulators: undefined });
  });

  it.effect("names the expiry of a lease taken under the largest TTL", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases(
        deviceLeaseOptions({ T3CODE_DEVICE_LEASE_TTL_SECONDS: "1e20" }),
      );
      yield* leases.acquire(request(a));
      expect(yield* leases.acquire(request(b)).pipe(Effect.flip)).toMatchObject({
        reason: "held",
        holders: [{ expiresAt: "1970-01-08T00:00:00.000Z" }],
      });
    }),
  );

  it("boots read-only templates only when opted in with more than one slot", () => {
    const optIn = { T3CODE_DEVICE_EMULATOR_READ_ONLY: "1" };
    expect(readOnlyEmulatorArgs(optIn)).toBeUndefined();
    expect(readOnlyEmulatorArgs({ ...optIn, T3CODE_DEVICE_MAX_LOCAL_EMULATORS: "1" })).toBe(
      undefined,
    );
    expect(readOnlyEmulatorArgs({ T3CODE_DEVICE_MAX_LOCAL_EMULATORS: "2" })).toBeUndefined();
    expect(readOnlyEmulatorArgs({ ...optIn, T3CODE_DEVICE_MAX_LOCAL_EMULATORS: "2" })).toBe(
      "-read-only -no-snapshot",
    );
  });
});

describe("makeDeviceLeases", () => {
  it.effect("renews the holder's own lease instead of granting a second one", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases();
      const first = yield* leases.acquire(request(a));
      yield* TestClock.adjust("10 minutes");
      const again = yield* leases.acquire(request(a));
      expect(again).toMatchObject({ fresh: false });
      expect(again.lease).toBe(first.lease);
      expect((yield* leases.holders)[0]?.expiresAt).toBe("1970-01-01T00:40:00.000Z");
    }),
  );

  it.effect("keeps a lease alive while its holder heartbeats past the TTL", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases({ ttl: Duration.minutes(5) });
      yield* leases.acquire(request(a));
      for (let beat = 0; beat < 3; beat++) {
        yield* TestClock.adjust("4 minutes");
        yield* leases.renew(request(a));
      }
      expect(yield* leases.acquire(request(b)).pipe(Effect.flip)).toMatchObject({ reason: "held" });
      expect(yield* leases.expiredBlockers(request(b))).toEqual([]);
      yield* TestClock.adjust("5 minutes");
      const [stale] = yield* leases.expiredBlockers(request(b));
      expect(stale?.threadId).toBe(a);
      // Expired, it still holds until its session is ended and the lease given back.
      expect(yield* leases.acquire(request(b)).pipe(Effect.flip)).toMatchObject({ reason: "held" });
      yield* leases.release(stale!);
      expect((yield* leases.acquire(request(b))).fresh).toBe(true);
    }),
  );

  it.effect("follows the booted serial and refuses to rebind onto another thread's device", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases();
      const { lease } = yield* leases.acquire(request(a));
      yield* leases.bind(lease, serial);
      expect(yield* leases.acquire(request(b, serial)).pipe(Effect.flip)).toMatchObject({
        holders: [{ threadId: a, deviceId: serial }],
      });
      // The AVD name is free again; a second boot of it lands on the serial thread a holds.
      const other = yield* leases.acquire(request(b));
      expect(yield* leases.bind(other.lease, serial).pipe(Effect.flip)).toMatchObject({
        reason: "held",
        holders: [{ threadId: a }],
      });
    }),
  );

  it.effect("ends active leases whose session is gone and keeps leases still booting", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases();
      const active = yield* leases.acquire(request(a, serial));
      leases.activate(active.lease);
      yield* leases.acquire(request(b));
      leases.retain([session(a, serial)]);
      expect((yield* leases.holders).map((holder) => holder.threadId)).toEqual([a, b]);
      leases.retain([]);
      expect((yield* leases.holders).map((holder) => holder.threadId)).toEqual([b]);
    }),
  );

  it.effect("reclaims only expired emulators to make room under the host cap", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases({ ttl: Duration.minutes(5), maxLocalEmulators: 1 });
      yield* leases.acquire(request(a, serial));
      const refused = yield* leases.acquire(request(b)).pipe(Effect.flip);
      expect(refused).toMatchObject({ reason: "host_limit", limit: 1 });
      expect(refused.message).toContain("1 leased emulators");
      expect(yield* leases.acquire({ ...request(b), emulator: false })).toMatchObject({
        fresh: true,
      });
      const next = request(b, DeviceId.make("Pixel_API_36"));
      expect(yield* leases.expiredBlockers(next)).toEqual([]);
      yield* TestClock.adjust("5 minutes");
      const reclaimable = yield* leases.expiredBlockers(next);
      expect(reclaimable.map((lease) => lease.deviceId)).toEqual([serial]);
      for (const lease of reclaimable) yield* leases.release(lease);
      expect((yield* leases.acquire(next)).fresh).toBe(true);
    }),
  );

  it.effect("gives back a failed open's lease but never a newer one", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases();
      const failed = yield* leases.acquire(request(a));
      yield* leases.release(failed.lease);
      const retried = yield* leases.acquire(request(a));
      expect(retried.fresh).toBe(true);
      yield* leases.release(failed.lease);
      expect((yield* leases.holders).map((holder) => holder.threadId)).toEqual([a]);
    }),
  );

  it.effect("restores a renewed lease that a concurrent open of the same thread gave back", () =>
    Effect.gen(function* () {
      const leases = makeDeviceLeases();
      const first = yield* leases.acquire(request(a));
      const second = yield* leases.acquire(request(a));
      yield* leases.release(first.lease);
      expect(yield* leases.holders).toEqual([]);
      yield* leases.bind(second.lease, avd);
      leases.activate(second.lease);
      expect((yield* leases.holders).map((holder) => holder.threadId)).toEqual([a]);
    }),
  );
});
