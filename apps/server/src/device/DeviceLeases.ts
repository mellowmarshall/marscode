import {
  type DeviceHostId,
  type DeviceId,
  type DeviceLeaseHolder,
  DeviceLeaseUnavailableError,
  type DeviceSession,
  LOCAL_DEVICE_HOST_ID,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as Scheduler from "../scheduling/Scheduler.ts";

export interface DeviceLeaseOptions {
  /** A holder that does not renew for this long can be preempted by another thread. */
  readonly ttl: Duration.Duration;
  /** The most emulators and simulators leased at once on this machine; unset is no limit. */
  readonly maxLocalEmulators?: number | undefined;
  /** Cadence for the periodic background sweep of expired idle emulator leases; defaults to 5 minutes. */
  readonly sweepInterval?: Duration.Duration | undefined;
}

export const DEFAULT_DEVICE_LEASE_OPTIONS: DeviceLeaseOptions = { ttl: Duration.minutes(30) };
const DEFAULT_DEVICE_LEASE_SWEEP_INTERVAL = Duration.minutes(5);

// Ceilings keep `renewedAt + ttl` a valid date, so a refusal can always say when a lease expires.
export const MAX_DEVICE_LEASE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_LOCAL_EMULATORS = 64;

/** A positive integer, clamped to `max`; anything else is unset. */
const positiveInt = (value: string | undefined, max: number) => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : undefined;
};

export const deviceLeaseOptions = (env: NodeJS.ProcessEnv): DeviceLeaseOptions => {
  const ttlSeconds = positiveInt(env.T3CODE_DEVICE_LEASE_TTL_SECONDS, MAX_DEVICE_LEASE_TTL_SECONDS);
  return {
    ttl: ttlSeconds === undefined ? DEFAULT_DEVICE_LEASE_OPTIONS.ttl : Duration.seconds(ttlSeconds),
    maxLocalEmulators: positiveInt(env.T3CODE_DEVICE_MAX_LOCAL_EMULATORS, MAX_LOCAL_EMULATORS),
  };
};

/**
 * Emulator flags that boot AVDs as throwaway copies of their template, so several slots can run
 * without writing back to it. Opt-in, and only when more than one local emulator may run.
 */
export const readOnlyEmulatorArgs = (env: NodeJS.ProcessEnv): string | undefined =>
  (deviceLeaseOptions(env).maxLocalEmulators ?? 1) > 1 &&
  env.T3CODE_DEVICE_EMULATOR_READ_ONLY === "1"
    ? "-read-only -no-snapshot"
    : undefined;

export interface DeviceLeaseRequest {
  readonly threadId: ThreadId;
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
  /** Counts toward `maxLocalEmulators`. */
  readonly emulator: boolean;
}

export interface DeviceLease extends Omit<DeviceLeaseRequest, "deviceId"> {
  /** Changes once, when booting names the device by its serial instead of its AVD. */
  deviceId: DeviceId;
  /** Original device id at acquire (e.g. AVD name before `bind` moves to serial). */
  readonly initialDeviceId?: DeviceId | undefined;
  readonly acquiredAt: number;
  renewedAt: number;
  /** False while the open that took it still boots the device; no session backs it yet. */
  active: boolean;
  /** True while the periodic reaper holds `lifecycleLock` and is tearing this lease down. */
  reaping: boolean;
}

export interface DeviceLeaseGrant {
  readonly lease: DeviceLease;
  /** The open created the lease, so a failed open gives it back. */
  readonly fresh: boolean;
}

const leaseKey = (lease: { readonly hostId: string; readonly deviceId: string }) =>
  `${lease.hostId}\u0000${lease.deviceId}`;

const sameTarget = (
  a: { readonly threadId: string; readonly hostId: string; readonly deviceId: string },
  b: { readonly threadId: string; readonly hostId: string; readonly deviceId: string },
) => a.threadId === b.threadId && a.hostId === b.hostId && a.deviceId === b.deviceId;

/**
 * Exclusive device leases: one thread per device. Every check and change after the clock read is
 * synchronous, so two concurrent opens cannot both take a device.
 */
export const makeDeviceLeases = (options: DeviceLeaseOptions = DEFAULT_DEVICE_LEASE_OPTIONS) => {
  const leases = new Map<string, DeviceLease>();
  const ttl = Duration.toMillis(options.ttl);
  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  const holder = (lease: DeviceLease): DeviceLeaseHolder => ({
    threadId: lease.threadId,
    deviceId: lease.deviceId,
    heldSince: iso(lease.acquiredAt),
    expiresAt: iso(lease.renewedAt + ttl),
  });

  const held = (lease: DeviceLease) =>
    new DeviceLeaseUnavailableError({
      hostId: lease.hostId,
      deviceId: lease.deviceId,
      reason: "held",
      holders: [holder(lease)],
    });

  const isExpiredAt = (lease: DeviceLease, now: number) => now - lease.renewedAt >= ttl;
  const isReapableAt = (lease: DeviceLease, now: number) =>
    lease.active && lease.emulator && isExpiredAt(lease, now);

  /** What stands between a request and its lease, read synchronously after one clock read. */
  const contention = (request: DeviceLeaseRequest, now: number) => {
    const current = leases.get(leaseKey(request));
    if (current?.threadId === request.threadId) return { own: current } as const;
    const limit = options.maxLocalEmulators;
    const capped =
      request.emulator && request.hostId === LOCAL_DEVICE_HOST_ID && limit !== undefined;
    const running = capped
      ? [...leases.values()].filter(
          (lease) => lease !== current && lease.emulator && lease.hostId === LOCAL_DEVICE_HOST_ID,
        )
      : [];
    const expired = (lease: DeviceLease) => isExpiredAt(lease, now);
    const needed = capped ? running.length - limit + 1 : 0;
    const reclaimable = running
      .filter(expired)
      .toSorted((x, y) => x.renewedAt - y.renewedAt)
      .slice(0, Math.max(needed, 0));
    return { current, running, limit, needed, expired, reclaimable } as const;
  };

  /** Currently active emulator leases whose idle time has reached the TTL, oldest first. */
  const expiredLeases: Effect.Effect<ReadonlyArray<DeviceLease>> = Clock.currentTimeMillis.pipe(
    Effect.map((now) =>
      [...leases.values()]
        .filter((lease) => isReapableAt(lease, now))
        .toSorted((x, y) => x.renewedAt - y.renewedAt),
    ),
  );

  /** True only while this exact lease is still held, active, an emulator, and expired right now. */
  const isExpired = (lease: DeviceLease): Effect.Effect<boolean> =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => leases.get(leaseKey(lease)) === lease && isReapableAt(lease, now)),
    );

  /** Atomically claims a still-expired lease for teardown so concurrent renewals cannot half-abort it. */
  const beginReap = (lease: DeviceLease): Effect.Effect<boolean> =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        if (leases.get(leaseKey(lease)) !== lease || !isReapableAt(lease, now)) return false;
        lease.reaping = true;
        return true;
      }),
    );

  const endReap = (lease: DeviceLease): Effect.Effect<void> =>
    Effect.sync(() => {
      lease.reaping = false;
    });

  const findForTarget = (target: Pick<DeviceLease, "threadId" | "hostId" | "deviceId">) => {
    const direct = leases.get(leaseKey(target));
    if (direct && sameTarget(direct, target)) return direct;
    return [...leases.values()].find(
      (entry) =>
        entry.threadId === target.threadId &&
        entry.hostId === target.hostId &&
        entry.initialDeviceId === target.deviceId,
    );
  };

  const isReaping = (target: Pick<DeviceLease, "threadId" | "hostId" | "deviceId">) =>
    Effect.sync(() => findForTarget(target)?.reaping === true);

  /**
   * Expired leases whose sessions must end before `request` can be granted, or none when it is
   * granted already or would be refused anyway. They stay held until the caller ends them.
   */
  const expiredBlockers = Effect.fn("DeviceLeases.expiredBlockers")(function* (
    request: DeviceLeaseRequest,
  ) {
    const found = contention(request, yield* Clock.currentTimeMillis);
    if ("own" in found) return [];
    if (found.current && !found.expired(found.current)) return [];
    if (found.reclaimable.length < found.needed) return [];
    return [...(found.current ? [found.current] : []), ...found.reclaimable];
  });

  const acquire = Effect.fn("DeviceLeases.acquire")(function* (request: DeviceLeaseRequest) {
    const now = yield* Clock.currentTimeMillis;
    const found = contention(request, now);
    if ("own" in found) {
      found.own.renewedAt = now;
      return { lease: found.own, fresh: false } satisfies DeviceLeaseGrant;
    }
    if (found.current) return yield* held(found.current);
    if (found.needed > 0)
      return yield* new DeviceLeaseUnavailableError({
        hostId: request.hostId,
        deviceId: request.deviceId,
        reason: "host_limit",
        holders: found.running.map(holder),
        ...(found.limit === undefined ? {} : { limit: found.limit }),
      });
    const lease: DeviceLease = {
      ...request,
      initialDeviceId: request.deviceId,
      acquiredAt: now,
      renewedAt: now,
      active: false,
      reaping: false,
    };
    leases.set(leaseKey(request), lease);
    return { lease, fresh: true } satisfies DeviceLeaseGrant;
  });

  return {
    expiredBlockers,
    expiredLeases,
    isExpired,
    beginReap,
    endReap,
    isReaping,
    /** Grants a free device; an expired holder still holds until `expiredBlockers` are ended. */
    acquire,
    /**
     * Follows the id the device has once booted (an AVD becomes `emulator-5554`). Another
     * thread's lease on that id wins, expired or not: its session is live on the running device.
     */
    bind: (lease: DeviceLease, deviceId: DeviceId) =>
      Effect.suspend(() => {
        const key = leaseKey({ hostId: lease.hostId, deviceId });
        const other = leases.get(key);
        if (other && other.threadId !== lease.threadId) return Effect.fail(held(other));
        // Also puts back a lease a concurrent open of the same thread gave up while this one ran.
        if (leases.get(leaseKey(lease)) === lease) leases.delete(leaseKey(lease));
        lease.deviceId = deviceId;
        leases.set(key, lease);
        return Effect.void;
      }),
    /** The open's session is published; from now on the session list decides the lease. */
    activate: (lease: DeviceLease) => {
      if (leases.get(leaseKey(lease)) === lease) lease.active = true;
    },
    /** Gives back a lease whose open failed, or an expired one whose session has ended. */
    release: (lease: DeviceLease) =>
      Effect.sync(() => {
        if (leases.get(leaseKey(lease)) === lease) leases.delete(leaseKey(lease));
      }),
    /** Heartbeat: the holder is still using the device (skipped once reaper teardown has begun). */
    renew: Effect.fn("DeviceLeases.renew")(function* (
      target: Pick<DeviceLease, "threadId" | "hostId" | "deviceId">,
    ) {
      const lease = findForTarget(target);
      if (lease && !lease.reaping) lease.renewedAt = yield* Clock.currentTimeMillis;
    }),
    /** Ends every active lease whose session is gone: closed, shut down, or its thread ended. */
    retain: (sessions: ReadonlyArray<DeviceSession>) => {
      for (const [key, lease] of leases)
        if (lease.active && !sessions.some((session) => sameTarget(session, lease)))
          leases.delete(key);
    },
    holders: Effect.sync(() => [...leases.values()].map(holder)),
  };
};

export type DeviceLeases = ReturnType<typeof makeDeviceLeases>;

/**
 * Registers a periodic sweep on `Scheduler` (when `Scheduler` and `Scope` are in context)
 * that reaps expired idle emulator leases at `sweepInterval` cadence.
 */
export const registerExpiredLeaseSweep = Effect.fn("DeviceLeases.registerExpiredLeaseSweep")(
  function* <E>(input: {
    readonly leases: DeviceLeases;
    readonly sweepInterval?: Duration.Duration | undefined;
    readonly reap: (lease: DeviceLease) => Effect.Effect<void, E>;
  }) {
    const scheduler = yield* Effect.serviceOption(Scheduler.Scheduler);
    const scope = yield* Effect.serviceOption(Scope.Scope);
    if (Option.isNone(scheduler) || Option.isNone(scope)) {
      yield* Effect.logDebug(
        "Skipping device lease reaper registration; Scheduler or Scope is unavailable.",
      );
      return;
    }
    const intervalMs = Math.max(
      0,
      Duration.toMillis(input.sweepInterval ?? DEFAULT_DEVICE_LEASE_SWEEP_INTERVAL),
    );
    const lastSweepAt = yield* Ref.make(yield* Clock.currentTimeMillis);
    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - (yield* Ref.get(lastSweepAt)) < intervalMs) return;
      yield* Ref.set(lastSweepAt, now);
      for (const stale of yield* input.leases.expiredLeases) {
        yield* input.reap(stale).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to reap expired device lease", {
              threadId: stale.threadId,
              hostId: stale.hostId,
              deviceId: stale.deviceId,
              error,
            }),
          ),
        );
      }
    });
    yield* scheduler.value
      .register("device-lease-reaper", sweep)
      .pipe(Effect.provideService(Scope.Scope, scope.value));
  },
);
