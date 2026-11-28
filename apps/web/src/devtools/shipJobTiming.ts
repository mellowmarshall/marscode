/**
 * When a ship-queue job started and ended. Every Ship Queue view (thread card, table, linger)
 * reads job times here, so they agree on one end time.
 */
import type { ShipQueueJob } from "./devtoolsClient";

const JOB_KEY_EPOCH_RE = /^(\d{9,11})-j/;
// The queue writes `at=` with milliseconds (`…T08:50:37.370Z`); without them the zone is lost
// and `Date.parse` reads the time as local time.
const MARKER_AT_RE = /\bat=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:?\d{2}|Z))/;

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The job's start: `submitted_at`, else the epoch in its queue `key`. */
export function parseShipJobStartMs(job: ShipQueueJob): number | null {
  const submitted = parseMs(job.submitted_at);
  if (submitted !== null) return submitted;
  const match = job.key ? JOB_KEY_EPOCH_RE.exec(job.key) : null;
  if (match?.[1]) {
    const sec = Number(match[1]);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  return null;
}

/** The job's end: the queue's `ended_at`, else the zoned `at=` of its last marker (`DONE … at=`). */
export function resolveShipJobEndMs(job: ShipQueueJob): number | null {
  return parseMs(job.ended_at) ?? parseMs(MARKER_AT_RE.exec(job.last_marker ?? "")?.[1]);
}
