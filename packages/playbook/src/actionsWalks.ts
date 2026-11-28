/**
 * Declared walks (PLAYBOOK §9) for `playbook actions required`: the walks file's shape
 * ({"walks": [{name, actions, core, maxSeconds}], "standalone"?, "device"?, "by"?}), the
 * measuredBy modes, and the static rules, each refusal worded as the original words it.
 */ import { isPyJsonError, pyJsonLoads } from "./pyJson.ts";
import {
  isDict,
  isNumber,
  numeric,
  PyDict,
  pyEq,
  PyFloat,
  pyRepr,
  pySorted,
  pyStrip,
  type PyValue,
} from "./pyValues.ts";

export const GATE = "merge-gate";
export const EVIDENCE = "evidence";
const KEY = "measuredBy";
const MODES = [GATE, EVIDENCE];
/** The original's NAME regex, `^[a-z][a-z0-9-]*$`, with Python's `$`. */
const NAME = /^[a-z][a-z0-9-]*\n?$/;
const WALK_KEYS = ["name", "actions", "core", "maxSeconds"];

export interface Walk {
  readonly name: string;
  readonly actions: ReadonlyArray<string>;
  readonly core: boolean;
  /** The walk's entry as the file holds it (compared whole). */
  readonly raw: PyDict;
}

export interface Walks {
  readonly walks: ReadonlyArray<Walk>;
  readonly standalone: ReadonlyMap<string, string>;
  readonly device: ReadonlyMap<string, string>;
  readonly by: string | null;
}

export const EMPTY_WALKS: Walks = { walks: [], standalone: new Map(), device: new Map(), by: null };

const sameKeys = (d: PyDict, keys: ReadonlyArray<string>) =>
  d.size === keys.length && keys.every((k) => d.has(k));

function isWalk(w: PyValue): w is PyDict {
  if (!isDict(w) || !sameKeys(w, WALK_KEYS)) return false;
  const name = w.get("name");
  const actions = w.get("actions");
  const max = w.get("maxSeconds");
  return (
    typeof name === "string" &&
    NAME.test(name) &&
    Array.isArray(actions) &&
    actions.length > 0 &&
    actions.every((a) => typeof a === "string" && a !== "") &&
    typeof w.get("core") === "boolean" &&
    max !== undefined &&
    isNumber(max) &&
    numeric(max as number | PyFloat) > 0
  );
}

/** (the walks, or null when the file cannot be read; actions/walks-shape problems). */
export function parseWalks(text: string | null, rel: string): [Walks | null, string[]] {
  const bad = `actions/walks-shape: ${rel}`;
  let data: PyValue | null;
  try {
    data = text === null ? null : pyJsonLoads(text);
  } catch (cause) {
    if (!isPyJsonError(cause)) throw cause;
    return [null, [`${bad} is not JSON (${cause.message})`]];
  }
  if (data === null) {
    return [null, [`${bad} does not exist: write the walks file contracts.actions.walks names`]];
  }
  if (!isDict(data) || !Array.isArray(data.get("walks"))) {
    return [
      null,
      [
        `${bad} is not {"walks": [...], "standalone"?: {...}, "device"?: {...}, "by"?: "<harness>"}`,
      ],
    ];
  }
  const allowed = new Set(["$schema", "walks", "standalone", "device", "by"]);
  const problems = pySorted(data.keys().filter((k) => !allowed.has(k))).map(
    (k) => `${bad}: unknown key ${pyRepr(k)}`,
  );
  const walks: Walk[] = [];
  (data.get("walks") as PyValue[]).forEach((w, i) => {
    if (!isWalk(w)) {
      problems.push(
        `${bad}: walks[${i}] is not {name (kebab-case), actions (a list of action ids), core (true or false), maxSeconds (seconds, above 0)}`,
      );
      return;
    }
    walks.push({
      name: w.get("name") as string,
      actions: w.get("actions") as string[],
      core: w.get("core") as boolean,
      raw: w,
    });
  });
  const reasons = (key: string): Map<string, string> => {
    const val = data.has(key) ? data.get(key)! : new PyDict();
    if (isDict(val) && val.entries().every(([, v]) => typeof v === "string")) {
      return new Map(val.entries() as Array<[string, string]>);
    }
    problems.push(`${bad}: ${key} is not {"<action id>": "<reason>"}`);
    return new Map();
  };
  const standalone = reasons("standalone");
  const device = reasons("device");
  const by = data.has("by") ? data.get("by")! : null;
  let harness: string | null = null;
  if (
    by !== null &&
    !(
      typeof by === "string" &&
      pyStrip(by) !== "" &&
      !by.startsWith("/") &&
      !by.split("/").includes("..")
    )
  ) {
    problems.push(`${bad}: by is not the walk harness's path inside the repo`);
  } else {
    harness = by as string | null;
  }
  return [{ walks, standalone, device, by: harness }, problems];
}

export function hasMergeGate(settings: PyDict): boolean {
  const mb = settings.get(KEY);
  return mb === GATE || (isDict(mb) && mb.entries().some(([, v]) => pyEq(v, GATE)));
}

/** Partition the catalog's action ids into (merge-gate ids, evidence ids, settings problems). */
export function modesOf(settings: PyDict, catalog: PyDict): [Set<string>, Set<string>, string[]] {
  const bad = "actions/walks-settings: contracts.actions";
  const mb = settings.get(KEY);
  if (mb === undefined || mb === null) return [new Set(), new Set(catalog.keys()), []];
  if (mb === GATE) return [new Set(catalog.keys()), new Set(), []];
  if (!isDict(mb)) {
    return [
      new Set(),
      new Set(),
      [`${bad}.${KEY} must be 'merge-gate' or {"<platform>": "merge-gate"|"evidence"}`],
    ];
  }
  const problems: string[] = [];
  if (mb.size === 0) problems.push(`${bad}.${KEY} must declare at least one platform`);
  for (const plat of pySorted(mb.keys())) {
    if (!pyStrip(plat) || !MODES.some((m) => pyEq(mb.get(plat), m))) {
      problems.push(`${bad}.${KEY}[${pyRepr(plat)}] must be 'merge-gate' or 'evidence'`);
    }
  }
  const gate = new Set<string>();
  const ev = new Set<string>();
  const missing = new Map<string, string>();
  for (const aid of pySorted(catalog.keys())) {
    const act = catalog.get(aid);
    const plat = isDict(act) ? act.get("platform") : undefined;
    if (!(typeof plat === "string" && pyStrip(plat))) {
      problems.push(
        `${bad}.${KEY}: action ${aid} has no platform, required for per-platform measuredBy`,
      );
      continue;
    }
    if (!mb.has(plat)) {
      if (!missing.has(plat)) missing.set(plat, aid);
      continue;
    }
    if (pyEq(mb.get(plat), GATE)) gate.add(aid);
    else if (pyEq(mb.get(plat), EVIDENCE)) ev.add(aid);
  }
  for (const plat of pySorted(missing.keys())) {
    problems.push(
      `${bad}.${KEY}: platform ${pyRepr(plat)} (for example ${missing.get(plat)}) has no entry in measuredBy`,
    );
  }
  return [gate, ev, problems];
}

/** 'merge-gate', 'evidence', 'mixed', or null when no action of the walk belongs to a mode. */
export function walkMode(walk: Walk, gate: Set<string>, ev: Set<string>): string | null {
  const inGate = walk.actions.some((a) => gate.has(a));
  const inEv = walk.actions.some((a) => ev.has(a));
  if (inGate && inEv) return "mixed";
  if (inGate) return GATE;
  if (inEv) return EVIDENCE;
  return null;
}

export function settingsProblems(
  settings: PyDict,
  contracts: PyDict,
  walks: Walks | null,
  modeProblems: ReadonlyArray<string>,
): string[] {
  const bad = "actions/walks-settings: contracts.actions";
  const out = [...modeProblems];
  const closure = settings.get("closure");
  if (!(typeof closure === "string" && pyStrip(closure))) {
    out.push(
      `${bad} declares walks but no closure: declare the command that prints {"<action id>": "<digest>"}, the digest of each action's import closure`,
    );
  }
  const intent = contracts.get("intent");
  if (!isDict(intent) || intent.has("none")) {
    out.push(
      `${bad} declares walks, but contracts.intent is not declared: declare it, so that a change to a walk is declared under ## Contract Intent`,
    );
  }
  if (hasMergeGate(settings) && walks !== null && !walks.by) {
    out.push(
      `${bad}.${KEY} uses ${GATE}, but ${String(settings.get("walks"))} names no harness: set "by" to the walk harness the merge gate runs`,
    );
  }
  return out;
}

/** The static rules: every one a failure the original names in these words. */
export function staticProblems(
  walks: Walks,
  ids: Set<string>,
  rel: string,
  catalog: string,
  gate: Set<string> | null,
  ev: Set<string> | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const inWalks = new Set<string>();
  for (const w of walks.walks) {
    if (seen.has(w.name)) {
      out.push(
        `actions/walk-duplicate: ${rel} declares walk ${w.name} twice: rename one, or merge them`,
      );
    }
    seen.add(w.name);
    for (const a of w.actions) inWalks.add(a);
    for (const a of pySorted(new Set(w.actions.filter((x) => !ids.has(x))))) {
      out.push(
        `actions/walk-unknown-action: walk ${w.name} names ${a}, which is not in ${catalog}: catalog it or remove it from the walk`,
      );
    }
    if (gate !== null && ev !== null && walkMode(w, gate, ev) === "mixed") {
      out.push(
        `actions/walk-mixed-mode: walk ${w.name} mixes merge-gate and evidence actions: split it so every action in a walk uses one measuredBy mode`,
      );
    }
  }
  const standalone = pySorted(walks.standalone.keys());
  for (const a of standalone.filter((x) => !ids.has(x))) {
    out.push(
      `actions/walk-unknown-action: standalone names ${a}, which is not in ${catalog}: remove it from ${rel}`,
    );
  }
  for (const a of standalone) {
    if (!pyStrip(walks.standalone.get(a)!)) {
      out.push(
        `actions/standalone-reason: standalone ${a} gives no reason: say which fault its test sets up first`,
      );
    }
  }
  const device = pySorted(walks.device.keys());
  for (const a of device.filter((x) => !ids.has(x))) {
    out.push(
      `actions/walk-unknown-action: device names ${a}, which is not in ${catalog}: remove it from ${rel}`,
    );
  }
  for (const a of device) {
    if (!pyStrip(walks.device.get(a)!)) {
      out.push(
        `actions/device-reason: device ${a} gives no reason: say which hardware or target CI lacks`,
      );
    }
    if (inWalks.has(a) || walks.standalone.has(a)) {
      const place = inWalks.has(a) ? "a walk" : "standalone";
      out.push(
        `actions/device-overlap: ${a} is in device and also in ${place}: remove it from device if a walk or standalone run proves it`,
      );
    }
  }
  const covered = new Set([...inWalks, ...walks.standalone.keys(), ...walks.device.keys()]);
  for (const a of pySorted([...ids].filter((x) => !covered.has(x)))) {
    out.push(
      `actions/walk-uncovered: ${a} is in no walk of ${rel} and is not standalone or device: add it to the walk that reaches it, or mark it standalone or device with the reason`,
    );
  }
  return out;
}
