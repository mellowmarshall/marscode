/**
 * Effect Schema boundary decoders for external DevDeck JSON payloads (`hosts`, `ship`, `host`).
 * Decodes arrays row-by-row with lenient scalar coercion so a single unexpected field type
 * (e.g., numeric `pr`, numeric tool `version`, `{ text, state }` drift objects, or `no_grant: []`)
 * never crashes React or blanks an entire panel.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  DevdeckDiskInfo,
  DevdeckDriftEntry,
  DevdeckHostProbeReport,
  DevdeckHostTelemetry,
  DevdeckHostsPanel,
  DevdeckShipCiTurn,
  DevdeckShipDepEntry,
  DevdeckShipHostCheck,
  DevdeckShipJobSummary,
  DevdeckShipPanel,
  DevdeckToolProbe,
} from "./devdeckTypes";

const ScalarString = Schema.NullOr(Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));
const NullableNumber = Schema.NullOr(Schema.Union([Schema.Number, Schema.String]));
const NullableBool = Schema.NullOr(Schema.Boolean);
const RecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const DevdeckDriftEntrySchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    text: Schema.optional(ScalarString),
    state: Schema.optional(ScalarString),
    message: Schema.optional(ScalarString),
    tool: Schema.optional(ScalarString),
    installed: Schema.optional(ScalarString),
    expected: Schema.optional(ScalarString),
  }),
]);

const DevdeckToolProbeSchema = Schema.Struct({
  name: ScalarString,
  range: Schema.optional(ScalarString),
  version: Schema.optional(ScalarString),
  state: Schema.optional(ScalarString),
  install: Schema.optional(ScalarString),
});

const DevdeckHostProbeReportSchema = Schema.Struct({
  name: ScalarString,
  ssh: Schema.optional(ScalarString),
  reached: Schema.optional(NullableBool),
  probed_at: Schema.optional(ScalarString),
  platform: Schema.optional(ScalarString),
  tools: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  drift: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  notes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  ci_off: Schema.optional(NullableBool),
  ci_off_at: Schema.optional(ScalarString),
  ci_off_by: Schema.optional(ScalarString),
  ci_off_reason: Schema.optional(ScalarString),
  ci_off_version: Schema.optional(ScalarString),
  no_grant: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.Boolean, Schema.Array(Schema.Unknown)])),
  ),
  grant_error: Schema.optional(ScalarString),
});

const DevdeckShipHostCheckSchema = Schema.Struct({
  name: ScalarString,
  where: Schema.optional(ScalarString),
  state: Schema.optional(ScalarString),
  drift: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  notes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const DevdeckShipDepEntrySchema = Schema.Struct({
  repo: Schema.optional(ScalarString),
  report: Schema.optional(ScalarString),
  status: Schema.optional(ScalarString),
  scanned: Schema.optional(NullableNumber),
  pending: Schema.optional(NullableNumber),
  waiting: Schema.optional(NullableNumber),
  held: Schema.optional(NullableNumber),
  failed: Schema.optional(NullableNumber),
  attempt: Schema.optional(ScalarString),
  decision: Schema.optional(ScalarString),
  active: Schema.optional(NullableBool),
  holding: Schema.optional(NullableBool),
});

const DevdeckShipJobSummarySchema = Schema.Struct({
  id: Schema.optional(ScalarString),
  repo: Schema.optional(ScalarString),
  branch: Schema.optional(ScalarString),
  title: Schema.optional(ScalarString),
  state: Schema.optional(ScalarString),
  stage: Schema.optional(ScalarString),
  pr: Schema.optional(ScalarString),
  reason: Schema.optional(ScalarString),
  cleared: Schema.optional(ScalarString),
  host: Schema.optional(ScalarString),
  started_at: Schema.optional(ScalarString),
  updated_at: Schema.optional(ScalarString),
  finished_at: Schema.optional(ScalarString),
  duration_s: Schema.optional(NullableNumber),
});

const DevdeckShipCiTurnSchema = Schema.Struct({
  repo: Schema.optional(ScalarString),
  holder: Schema.optional(ScalarString),
  waiting: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.Array(ScalarString), Schema.Number])),
  ),
});

const DevdeckDiskSchema = Schema.Struct({
  mount: Schema.optional(ScalarString),
  label: Schema.optional(ScalarString),
  used: Schema.optional(NullableNumber),
  total: Schema.optional(NullableNumber),
});

const decodeRecord = Schema.decodeUnknownOption(RecordSchema);
const decodeDrift = Schema.decodeUnknownOption(DevdeckDriftEntrySchema);
const decodeTool = Schema.decodeUnknownOption(DevdeckToolProbeSchema);
const decodeHostProbe = Schema.decodeUnknownOption(DevdeckHostProbeReportSchema);
const decodeShipHost = Schema.decodeUnknownOption(DevdeckShipHostCheckSchema);
const decodeShipDep = Schema.decodeUnknownOption(DevdeckShipDepEntrySchema);
const decodeShipJob = Schema.decodeUnknownOption(DevdeckShipJobSummarySchema);
const decodeShipCi = Schema.decodeUnknownOption(DevdeckShipCiTurnSchema);
const decodeDisk = Schema.decodeUnknownOption(DevdeckDiskSchema);

function asStr(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return undefined;
}

function asNonEmpty(v: unknown): string | undefined {
  const s = asStr(v);
  return s && s.length > 0 ? s : undefined;
}

function asNullableStr(v: unknown): string | null | undefined {
  return v === null ? null : asStr(v);
}

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asNumArray(v: unknown): ReadonlyArray<number> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((item) => {
    const n = asNum(item);
    return n !== undefined ? [n] : [];
  });
}

function opt<K extends string, V>(key: K, val: V | undefined): Partial<Record<K, V>> {
  return val !== undefined ? ({ [key]: val } as Partial<Record<K, V>>) : {};
}

function decodeDriftEntries(raw: ReadonlyArray<unknown>): ReadonlyArray<DevdeckDriftEntry> {
  return raw.flatMap((item): ReadonlyArray<DevdeckDriftEntry> => {
    const dec = decodeDrift(item);
    if (Option.isNone(dec)) return [];
    const val = dec.value;
    if (typeof val === "string") return [val];
    const text =
      asStr(val.text) ??
      asStr(val.message) ??
      (val.tool
        ? `${asStr(val.tool) ?? ""}${val.installed ? ` ${asStr(val.installed)}` : ""}${val.expected ? ` → ${asStr(val.expected)}` : ""}`.trim()
        : null);
    return [{ text: text ?? null, state: asStr(val.state) ?? null }];
  });
}

function decodeToolRows(raw: ReadonlyArray<unknown>): ReadonlyArray<DevdeckToolProbe> {
  return raw.flatMap((item): ReadonlyArray<DevdeckToolProbe> => {
    const dec = decodeTool(item);
    if (Option.isNone(dec)) return [];
    const t = dec.value;
    const name = asNonEmpty(t.name);
    if (!name) return [];
    return [
      {
        name,
        ...opt("range", asNonEmpty(t.range)),
        ...opt("version", asNonEmpty(t.version)),
        ...opt("state", asNonEmpty(t.state)),
        ...opt("install", asNonEmpty(t.install)),
      },
    ];
  });
}

function decodeHostProbeRows(raw: ReadonlyArray<unknown>): ReadonlyArray<DevdeckHostProbeReport> {
  return raw.flatMap((item): ReadonlyArray<DevdeckHostProbeReport> => {
    const dec = decodeHostProbe(item);
    if (Option.isNone(dec)) return [];
    const h = dec.value;
    const name = asNonEmpty(h.name);
    if (!name) return [];
    return [
      {
        name,
        ...opt("ssh", asNullableStr(h.ssh)),
        ...(typeof h.reached === "boolean" ? { reached: h.reached } : {}),
        ...opt("probed_at", asNullableStr(h.probed_at)),
        ...opt("platform", asNonEmpty(h.platform)),
        ...(Array.isArray(h.tools) ? { tools: decodeToolRows(h.tools) } : {}),
        ...(Array.isArray(h.drift) ? { drift: decodeDriftEntries(h.drift) } : {}),
        ...(Array.isArray(h.notes) ? { notes: decodeDriftEntries(h.notes) } : {}),
        ...(typeof h.ci_off === "boolean" ? { ci_off: h.ci_off } : {}),
        ...opt("ci_off_at", asNullableStr(h.ci_off_at)),
        ...opt("ci_off_by", asNullableStr(h.ci_off_by)),
        ...opt("ci_off_reason", asNullableStr(h.ci_off_reason)),
        ...opt("ci_off_version", asNullableStr(h.ci_off_version)),
        ...(h.no_grant !== undefined && h.no_grant !== null ? { no_grant: h.no_grant } : {}),
        ...opt("grant_error", asNullableStr(h.grant_error)),
      },
    ];
  });
}

export function decodeDevdeckHostsPanel(raw: unknown): DevdeckHostsPanel | null {
  const recOpt = decodeRecord(raw);
  if (Option.isNone(recOpt)) return null;
  const obj = recOpt.value;
  const reportOpt = obj.report ? decodeRecord(obj.report) : Option.none();
  const base = {
    ...opt("running", asNonEmpty(obj.running)),
    ...opt("error", asNonEmpty(obj.error)),
  };
  if (Option.isNone(reportOpt)) return { report: null, ...base };
  const rep = reportOpt.value;
  return {
    report: {
      ...opt("at", asNonEmpty(rep.at)),
      ...(Array.isArray(rep.hosts) ? { hosts: decodeHostProbeRows(rep.hosts) } : {}),
    },
    ...base,
  };
}

export function decodeDevdeckShipPanel(raw: unknown): DevdeckShipPanel | null {
  const recOpt = decodeRecord(raw);
  if (Option.isNone(recOpt)) return null;
  const obj = recOpt.value;

  const jobs: ReadonlyArray<DevdeckShipJobSummary> | undefined = Array.isArray(obj.jobs)
    ? obj.jobs.flatMap((item): ReadonlyArray<DevdeckShipJobSummary> => {
        const dec = decodeShipJob(item);
        if (Option.isNone(dec)) return [];
        const j = dec.value;
        return [
          {
            ...opt("id", asNonEmpty(j.id)),
            ...opt("repo", asNonEmpty(j.repo)),
            ...opt("branch", asNonEmpty(j.branch)),
            ...opt("title", asNonEmpty(j.title)),
            ...opt("state", asNonEmpty(j.state)),
            ...opt("stage", asNonEmpty(j.stage)),
            ...opt("pr", asNonEmpty(j.pr)),
            ...opt("reason", asNonEmpty(j.reason)),
            ...opt("cleared", asNonEmpty(j.cleared)),
            ...opt("host", asNonEmpty(j.host)),
            ...opt("started_at", asNonEmpty(j.started_at)),
            ...opt("updated_at", asNonEmpty(j.updated_at)),
            ...opt("finished_at", asNonEmpty(j.finished_at)),
            ...opt("duration_s", asNum(j.duration_s)),
          },
        ];
      })
    : undefined;

  const ci: ReadonlyArray<DevdeckShipCiTurn> | undefined = Array.isArray(obj.ci)
    ? obj.ci.flatMap((item): ReadonlyArray<DevdeckShipCiTurn> => {
        const dec = decodeShipCi(item);
        if (Option.isNone(dec)) return [];
        const c = dec.value;
        const waiting: ReadonlyArray<string> | number | undefined =
          typeof c.waiting === "number"
            ? c.waiting
            : Array.isArray(c.waiting)
              ? c.waiting.map((w) => asStr(w)).filter((w): w is string => Boolean(w))
              : undefined;
        return [
          {
            ...opt("repo", asNonEmpty(c.repo)),
            ...opt("holder", asNonEmpty(c.holder)),
            ...opt("waiting", waiting),
          },
        ];
      })
    : undefined;

  const hostsOpt = obj.hosts ? decodeRecord(obj.hosts) : Option.none();
  const hostsSection: DevdeckShipPanel["hosts"] = Option.isSome(hostsOpt)
    ? {
        ...opt("at", asNonEmpty(hostsOpt.value.at)),
        ...opt("exit", asNum(hostsOpt.value.exit)),
        ...(Array.isArray(hostsOpt.value.hosts)
          ? {
              hosts: hostsOpt.value.hosts.flatMap((item): ReadonlyArray<DevdeckShipHostCheck> => {
                const dec = decodeShipHost(item);
                if (Option.isNone(dec)) return [];
                const h = dec.value;
                const name = asNonEmpty(h.name);
                if (!name) return [];
                return [
                  {
                    name,
                    ...opt("where", asNonEmpty(h.where)),
                    ...opt("state", asNonEmpty(h.state)),
                    ...(Array.isArray(h.drift) ? { drift: decodeDriftEntries(h.drift) } : {}),
                    ...(Array.isArray(h.notes) ? { notes: decodeDriftEntries(h.notes) } : {}),
                  },
                ];
              }),
            }
          : {}),
        ...(Array.isArray(hostsOpt.value.notes)
          ? {
              notes: decodeDriftEntries(hostsOpt.value.notes)
                .map((e) => (typeof e === "string" ? e : (e.text ?? "")))
                .filter(Boolean),
            }
          : {}),
        ...(typeof hostsOpt.value.stale === "boolean" ? { stale: hostsOpt.value.stale } : {}),
      }
    : undefined;

  const deps: ReadonlyArray<DevdeckShipDepEntry> | undefined = Array.isArray(obj.deps)
    ? obj.deps.flatMap((item): ReadonlyArray<DevdeckShipDepEntry> => {
        const dec = decodeShipDep(item);
        if (Option.isNone(dec)) return [];
        const d = dec.value;
        return [
          {
            ...opt("repo", asNonEmpty(d.repo)),
            ...opt("report", asNonEmpty(d.report)),
            ...opt("status", asNonEmpty(d.status)),
            ...opt("scanned", asNum(d.scanned)),
            ...opt("pending", asNum(d.pending)),
            ...opt("waiting", asNum(d.waiting)),
            ...opt("held", asNum(d.held)),
            ...opt("failed", asNum(d.failed)),
            ...opt("attempt", asNonEmpty(d.attempt)),
            ...opt("decision", asNonEmpty(d.decision)),
            ...(typeof d.active === "boolean" ? { active: d.active } : {}),
            ...(typeof d.holding === "boolean" ? { holding: d.holding } : {}),
          },
        ];
      })
    : undefined;

  return {
    ...(typeof obj.daemon_up === "boolean" ? { daemon_up: obj.daemon_up } : {}),
    ...opt("jobs", jobs),
    ...opt("ci", ci),
    ...opt("hosts", hostsSection),
    ...opt("deps", deps),
  };
}

export function decodeDevdeckHostTelemetry(raw: unknown): DevdeckHostTelemetry | null {
  const recOpt = decodeRecord(raw);
  if (Option.isNone(recOpt)) return null;
  const v = recOpt.value;
  const memOpt = v.mem ? decodeRecord(v.mem) : Option.none();
  const gpuOpt = v.gpu ? decodeRecord(v.gpu) : Option.none();
  const disks: ReadonlyArray<DevdeckDiskInfo> | undefined = Array.isArray(v.disks)
    ? v.disks.flatMap((item): ReadonlyArray<DevdeckDiskInfo> => {
        const dec = decodeDisk(item);
        if (Option.isNone(dec)) return [];
        const d = dec.value;
        return [
          {
            ...opt("mount", asNonEmpty(d.mount)),
            ...opt("label", asNonEmpty(d.label)),
            ...opt("used", asNum(d.used)),
            ...opt("total", asNum(d.total)),
          },
        ];
      })
    : undefined;

  return {
    ...opt("name", asNonEmpty(v.name)),
    ...opt("uptime_s", asNum(v.uptime_s)),
    ...opt("load1", asNum(v.load1)),
    ...opt("cpus", asNum(v.cpus)),
    ...opt("cpu_pct", asNum(v.cpu_pct)),
    ...opt("cpu_hist", asNumArray(v.cpu_hist)),
    ...(Option.isSome(memOpt)
      ? {
          mem: {
            ...opt("used", asNum(memOpt.value.used)),
            ...opt("total", asNum(memOpt.value.total)),
          },
        }
      : {}),
    ...opt("disks", disks),
    ...(Option.isSome(gpuOpt)
      ? {
          gpu: {
            ...opt("busy_pct", asNum(gpuOpt.value.busy_pct)),
            ...opt("busy_hist", asNumArray(gpuOpt.value.busy_hist)),
            ...opt("vram_used", asNum(gpuOpt.value.vram_used)),
            ...opt("vram_total", asNum(gpuOpt.value.vram_total)),
          },
        }
      : {}),
    ...opt("ts", asNonEmpty(v.ts)),
  };
}
