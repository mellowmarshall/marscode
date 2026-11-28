/**
 * `playbook actions required [--base REF] [--mode merge-gate|evidence|all]` (PLAYBOOK §9), the
 * original's port: the core walks, the walks whose actions' closure changed or entered the mode,
 * changed or new walks, and changed standalone entries; each name's reason goes to stderr.
 */ import { loadOriginalDeclaration, parseBaseDeclaration } from "./actionsDeclaration.ts";
import {
  catalogActions,
  closure,
  gateBaseSha,
  gitShow,
  isGitError,
  readOnDisk,
  resolveRev,
  withScratchCheckout,
} from "./actionsSteps.ts";
import {
  EMPTY_WALKS,
  EVIDENCE,
  GATE,
  hasMergeGate,
  modesOf,
  parseWalks,
  settingsProblems,
  staticProblems,
  walkMode,
  type Walks,
} from "./actionsWalks.ts";
import { isDict, PyDict, pyCanon, pyEq, pyRepr, pySorted, pyTruthy } from "./pyValues.ts";

export interface ActionsIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
}

const dictAt = (d: PyDict | null | undefined, key: string): PyDict => {
  const v = d?.get(key);
  return isDict(v) ? v : new PyDict();
};

function baseSettings(env: NodeJS.ProcessEnv, root: string, sha: string): PyDict {
  let text: string | null;
  try {
    text = gitShow(env, root, sha, "playbook.json");
  } catch (cause) {
    if (isGitError(cause)) return new PyDict();
    throw cause;
  }
  const data = text ? parseBaseDeclaration(text) : null;
  return dictAt(dictAt(data, "contracts"), "actions");
}

function walksAt(
  env: NodeJS.ProcessEnv,
  root: string,
  rel: string,
  rev: string | null,
): [Walks | null, string[]] {
  let text: string | null;
  try {
    text = rev ? gitShow(env, root, rev, rel) : readOnDisk(root, rel);
  } catch (cause) {
    if (!isGitError(cause)) throw cause;
    return [null, [`actions/walks-shape: ${rel} cannot be read at ${rev}: ${cause.message}`]];
  }
  return parseWalks(text, rel);
}

const listed = (items: ReadonlyArray<string>) =>
  items.slice(0, 5).join(", ") + (items.length > 5 ? ` and ${items.length - 5} more` : "");

const strOr = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

type Decision = { readonly required: Array<[string, string]> } | { readonly why: string };

/** What must run, or why it cannot decide. */
async function decideRequired(
  env: NodeJS.ProcessEnv,
  root: string,
  base: string,
  mode: string | null,
): Promise<Decision> {
  const decl = loadOriginalDeclaration(root, env);
  if (decl.data === null || decl.errors.length > 0) {
    return { why: `playbook.json is invalid: ${decl.errors.slice(0, 3).join("; ")}` };
  }
  const contracts = dictAt(decl.data, "contracts");
  const rawSettings = contracts.get("actions");
  const settings = isDict(rawSettings) ? rawSettings : new PyDict();
  const rel = settings.get("walks");
  if (typeof rel !== "string") return { why: "playbook.json declares no contracts.actions.walks" };
  const sha = resolveRev(env, root, base);
  if (sha === null) return { why: `${base} is not a commit here (git fetch origin)` };
  const [head, walkProblems] = walksAt(env, root, rel, null);
  const catalog = strOr(settings.get("file"), "");
  const acts = catalogActions(env, root, catalog);
  const [gateIds, evIds, modeProblems] = modesOf(settings, acts);
  let problems = [...settingsProblems(settings, contracts, head, modeProblems), ...walkProblems];
  if (head !== null) {
    const clean = modeProblems.length === 0;
    problems = problems.concat(
      staticProblems(
        head,
        new Set(acts.keys()),
        rel,
        catalog,
        clean ? gateIds : null,
        clean ? evIds : null,
      ),
    );
  }
  if (head === null || problems.length > 0) {
    return { why: `the check refuses ${rel}: ${problems.slice(0, 3).join("; ")}` };
  }
  const selected = mode ?? (hasMergeGate(settings) ? GATE : EVIDENCE);
  if (![GATE, EVIDENCE, "all"].includes(selected)) {
    return { why: `unknown mode ${pyRepr(selected)} (expected merge-gate, evidence, or all)` };
  }
  const [tree, treeWhy] = await closure(env, root, settings.get("closure"), sha);
  if (tree === null) return { why: `${treeWhy} on the tree` };
  const baseCfg = baseSettings(env, root, sha);
  const baseRel = strOr(baseCfg.get("walks"), rel);
  const old = walksAt(env, root, baseRel, sha)[0] ?? EMPTY_WALKS;
  const baseActs = catalogActions(env, root, strOr(baseCfg.get("file"), catalog), sha);
  const [baseGate, baseEv] = modesOf(baseCfg, baseActs);
  const baseCommand = pyTruthy(baseCfg.get("closure"))
    ? baseCfg.get("closure")
    : settings.get("closure");
  const [atBase, baseWhy] = await withScratchCheckout(env, root, sha, async (scratch) =>
    scratch === null
      ? ([null, "git cannot write a scratch checkout of the base"] as const)
      : closure(env, scratch, baseCommand, sha),
  );
  const closureChanged = !pyEq(settings.get("closure"), baseCfg.get("closure"));
  const byChanged = head.by !== old.by;
  const baseUnreadable =
    atBase === null ? `every walk is required: ${baseWhy} at the base ${sha.slice(0, 12)}` : null;
  const before = new Map(old.walks.map((w) => [w.name, pyCanon(w.raw)]));
  const changed = new Set(
    [...tree.keys()].filter((a) => atBase === null || atBase.get(a) !== tree.get(a)),
  );
  const enteredGate = new Set([...gateIds].filter((a) => !baseGate.has(a)));
  const enteredEv = new Set([...evIds].filter((a) => !baseEv.has(a)));
  const pool =
    selected === GATE ? gateIds : selected === EVIDENCE ? evIds : new Set([...gateIds, ...evIds]);
  const wanted = new Set([...pool].filter((a) => !head.device.has(a)));

  const allWhy = (itemMode: string | null): string | null => {
    if (baseUnreadable) return baseUnreadable;
    const redef = [
      ...(closureChanged ? ["contracts.actions.closure"] : []),
      ...(byChanged && itemMode === GATE ? [`${rel} "by"`] : []),
    ];
    return redef.length > 0
      ? `every walk is required: ${redef.join(" and ")} changed, so no earlier proof holds`
      : null;
  };

  const required: Array<[string, string]> = [];
  for (const w of head.walks) {
    const wmode = walkMode(w, gateIds, evIds);
    if (selected !== "all" && wmode !== selected) continue;
    const everything = allWhy(wmode);
    const reasons = [...(w.core ? ["core"] : []), ...(everything ? [everything] : [])];
    if (before.get(w.name) !== pyCanon(w.raw)) {
      reasons.push(before.has(w.name) ? "its declaration changed" : "a new walk");
    }
    const entered = wmode === GATE ? enteredGate : enteredEv;
    const moved = pySorted(new Set(w.actions.filter((a) => changed.has(a) || !tree.has(a))));
    const newly = pySorted(new Set(w.actions.filter((a) => entered.has(a) && !moved.includes(a))));
    if (moved.length > 0 && !everything) reasons.push(`the closure of ${listed(moved)} changed`);
    if (newly.length > 0 && !everything) reasons.push(`${listed(newly)} entered ${wmode}`);
    if (reasons.length > 0) required.push([w.name, reasons.join("; ")]);
  }
  for (const a of pySorted(head.standalone.keys())) {
    if (!wanted.has(a)) continue;
    const amode = gateIds.has(a) ? GATE : EVIDENCE;
    const everything = allWhy(amode);
    const reasons = everything ? [everything] : [];
    if (old.standalone.get(a) !== head.standalone.get(a)) reasons.push("its entry changed");
    const entered = amode === GATE ? enteredGate : enteredEv;
    if (!everything) {
      if (changed.has(a) || !tree.has(a)) reasons.push("its closure changed");
      else if (entered.has(a)) reasons.push(`entered ${amode}`);
    }
    if (reasons.length > 0) required.push([`standalone:${a}`, reasons.join("; ")]);
  }
  return { required };
}

/** The command: its exit code (0 decided, 1 it cannot decide). */
export async function runActionsRequired(
  root: string,
  base: string | null,
  mode: string | null,
  io: ActionsIo,
): Promise<number> {
  const stop = (why: string) => {
    io.err(`playbook actions required: ${why}`);
    return 1;
  };
  const ref = base || gateBaseSha(io.env, root);
  if (!ref) return stop("no base to compare against: pass --base REF, or git fetch origin");
  const decision = await decideRequired(io.env, root, ref, mode);
  if ("why" in decision) return stop(decision.why || "it cannot decide");
  for (const [name, reason] of decision.required) {
    io.out(name);
    io.err(`${name}: ${reason}`);
  }
  return 0;
}
