// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Headless CLI on node:* builtins only.
/**
 * The `hygiene` command line (PLAYBOOK §16). Prints `<classId> <source>:<line> (<rule>)` per
 * finding and never the matched text. Exit 0 clean, 1 findings, 2 usage or invalid input.
 */
import * as NodeFS from "node:fs";

import { identityFindings, messageFindings, scanRange, scanStaged } from "./commitScan.ts";
import { displayPath, loadDenylist } from "./denylist.ts";
import {
  buildHygieneReceipt,
  detectLayers,
  probeTextGuard,
  treeOf,
  writeReceipt,
} from "./evidenceReceipt.ts";
import { fullScan } from "./fullScan.ts";
import { git, GitReadError } from "./gitRead.ts";
import { PolicyError, readPolicyFile } from "./hygienePolicy.ts";
import { HYGIENE_SURFACES, type HygieneSurface } from "./hygieneCatalog.ts";
import type { DenyRule, Finding } from "./hygieneTypes.ts";
import { identEmail } from "./identity.ts";
import { formatFinding, scanText } from "./textScan.ts";
import { scanTree } from "./treeScan.ts";

export const USAGE = `usage: hygiene staged
       hygiene commit-msg FILE
       hygiene range BASE
       hygiene tree [--public-only]
       hygiene text [FILE|-] --source LABEL [--surface tree|history|commit-metadata|github-text]
       hygiene evidence --base SHA --out FILE [--body FILE] [--title TEXT]`;

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readStdin: () => string;
  readonly textGuard: () => boolean;
}

const DEFAULT_IO: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
  readStdin: () => NodeFS.readFileSync(0, "utf8"),
  textGuard: probeTextGuard,
};

// @effect-diagnostics-next-line extendsNativeError:off - a plain CLI library; no Effect failure channel.
class UsageError extends Error {}

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

type DenylistUse =
  | {
      readonly kind: "rules";
      readonly rules: ReadonlyArray<DenyRule> | null;
      readonly missing?: string;
    }
  | { readonly kind: "invalid"; readonly message: string };

function useDenylist(io: CliIo, publicOnly: boolean): DenylistUse {
  if (publicOnly) return { kind: "rules", rules: null };
  const load = loadDenylist(io.env);
  if (load.kind === "loaded") return { kind: "rules", rules: load.rules };
  const shown = displayPath(load.path, io.env);
  if (load.kind === "invalid") {
    const where =
      load.line > 0 ? `line ${load.line}` : "must be a file readable by its owner only (chmod 600)";
    return { kind: "invalid", message: `hygiene: private denylist ${shown} is invalid: ${where}` };
  }
  return { kind: "rules", rules: null, missing: shown };
}

function report(io: CliIo, findings: ReadonlyArray<Finding>, missing: string | undefined): number {
  for (const finding of findings) io.out(`${formatFinding(finding)}\n`);
  if (missing) {
    io.err(`hygiene: private denylist missing; expected at ${missing} (public rules only ran)\n`);
  }
  io.err(findings.length === 0 ? "hygiene: clean\n" : `hygiene: ${findings.length} finding(s)\n`);
  return findings.length > 0 || missing ? 1 : 0;
}

function commitMsgFindings(root: string, file: string, rules: ReadonlyArray<DenyRule> | null) {
  const message = NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const policy = readPolicyFile(root);
  const options = { denylist: rules, policy };
  const out: Finding[] = [...messageFindings(message, "commit-msg", options)];
  for (const [label, variable] of [
    ["author", "GIT_AUTHOR_IDENT"],
    ["committer", "GIT_COMMITTER_IDENT"],
  ] as const) {
    const ident = git(root, ["var", variable]).trim();
    const name = ident.replace(/\s*<.*$/, "");
    out.push(...identityFindings(label, name, identEmail(ident) ?? "", options));
  }
  return out;
}

function runEvidence(
  io: CliIo,
  root: string,
  args: string[],
  rules: ReadonlyArray<DenyRule> | null,
) {
  const base = flagValue(args, "--base");
  const outFile = flagValue(args, "--out");
  const bodyFile = flagValue(args, "--body");
  const title = flagValue(args, "--title");
  if (!base || !outFile || args.length > 0)
    throw new UsageError("evidence needs --base SHA --out FILE");
  const githubTexts = [
    ...(title !== undefined ? [{ source: "pr-title", text: title }] : []),
    ...(bodyFile !== undefined
      ? [{ source: "pr-body", text: NodeFS.readFileSync(bodyFile, "utf8") }]
      : []),
  ];
  const policy = readPolicyFile(root);
  const run = fullScan({ root, baseSha: base, denylist: rules, policy, githubTexts });
  const receipt = buildHygieneReceipt({
    tree: treeOf(root, "HEAD"),
    jobId: io.env.PLAYBOOK_EVIDENCE_JOB?.trim() || undefined,
    generatedAt: new Date().toISOString(),
    run,
    layers: detectLayers(root, "HEAD", { shipGate: false, textGuard: io.textGuard }),
    policy,
  });
  writeReceipt(outFile, receipt);
  return run.findings;
}

function dispatch(io: CliIo, argv: ReadonlyArray<string>): number {
  const [command, ...rest] = argv;
  const args = [...rest];
  if (!command || command === "--help" || command === "-h") {
    io.out(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  const publicOnly = command === "tree" && args.includes("--public-only");
  if (publicOnly) args.splice(args.indexOf("--public-only"), 1);
  const root = git(io.cwd, ["rev-parse", "--show-toplevel"]).trim();
  const denylist = useDenylist(io, publicOnly);
  if (denylist.kind === "invalid") {
    io.err(`${denylist.message}\n`);
    return 2;
  }
  const options = { denylist: denylist.rules };
  let findings: ReadonlyArray<Finding>;
  if (command === "staged" && args.length === 0) {
    findings = scanStaged(root, options);
  } else if (command === "commit-msg" && args.length === 1) {
    findings = commitMsgFindings(root, args[0]!, denylist.rules);
  } else if (command === "range" && args.length === 1) {
    findings = scanRange(root, args[0]!, options);
  } else if (command === "tree" && args.length === 0) {
    findings = scanTree(root, options);
  } else if (command === "text") {
    const source = flagValue(args, "--source");
    const surface = flagValue(args, "--surface") ?? "tree";
    if (!source || args.length > 1) throw new UsageError("text needs --source LABEL");
    if (!(HYGIENE_SURFACES as ReadonlyArray<string>).includes(surface))
      throw new UsageError(`unknown surface ${surface}`);
    const input = args[0] ?? "-";
    const text = input === "-" ? io.readStdin() : NodeFS.readFileSync(input, "utf8");
    findings = scanText(text, { ...options, source, surface: surface as HygieneSurface });
  } else if (command === "evidence") {
    findings = runEvidence(io, root, args, denylist.rules);
  } else {
    throw new UsageError(`unknown or malformed command: ${command}`);
  }
  return report(io, findings, denylist.missing);
}

export function runHygieneCli(argv: ReadonlyArray<string>, io: Partial<CliIo> = {}): number {
  const full = { ...DEFAULT_IO, ...io };
  try {
    return dispatch(full, argv);
  } catch (cause) {
    if (cause instanceof UsageError) {
      full.err(`hygiene: ${cause.message}\n${USAGE}\n`);
    } else if (cause instanceof PolicyError || cause instanceof GitReadError) {
      full.err(`hygiene: ${cause.message}\n`);
    } else {
      full.err(
        `hygiene: ${cause instanceof Error ? cause.constructor.name : "error"}: could not complete the scan\n`,
      );
    }
    return 2;
  }
}
