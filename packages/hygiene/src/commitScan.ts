/**
 * PLAYBOOK §16.4 `history` and `commit-metadata` surfaces: staged and committed added lines,
 * new paths, messages, author/committer/trailer identities, and tags pointing into the range.
 */
import { git } from "./gitRead.ts";
import { isExcludedPath, readPolicyFile } from "./hygienePolicy.ts";
import type { Finding, HygienePolicy, ScanOptions } from "./hygieneTypes.ts";
import {
  checkIdentity,
  checkTrailerEmail,
  identEmail,
  isNeutralAgentTrailer,
  trailerEmails,
} from "./identity.ts";
import { PATCH_ARGS, parsePatch } from "./patchParse.ts";
import { scanLines, scanName, scanText, type NumberedLine } from "./textScan.ts";
import { pathFindings } from "./treeScan.ts";

type Scoped = ScanOptions & { readonly policy: HygienePolicy };

function patchFindings(patch: string, options: Scoped, prefix: string): Finding[] {
  const parsed = parsePatch(patch);
  const byFile = new Map<string, NumberedLine[]>();
  for (const added of parsed.added) {
    if (isExcludedPath(options.policy, added.file)) continue;
    const lines = byFile.get(added.file) ?? [];
    lines.push({ line: added.line, text: added.text });
    byFile.set(added.file, lines);
  }
  const out: Finding[] = [];
  for (const [file, lines] of byFile) {
    out.push(
      ...scanLines(lines, {
        source: `${prefix}${file}`,
        surface: "history",
        denylist: options.denylist,
        policy: options.policy,
        file,
      }),
    );
  }
  for (const file of parsed.newFiles) {
    if (isExcludedPath(options.policy, file)) continue;
    for (const finding of pathFindings(file, options)) {
      out.push({ ...finding, source: `${prefix}${finding.source}` });
    }
  }
  return out;
}

function scoped(root: string, options: ScanOptions): Scoped {
  return { ...options, policy: options.policy ?? readPolicyFile(root) };
}

/** The staged added lines and new paths (what a pre-commit hook is about to record). */
export function scanStaged(root: string, options: ScanOptions): ReadonlyArray<Finding> {
  const patch = git(root, ["diff", "--cached", "--diff-filter=ACMRT", ...PATCH_ARGS]);
  return patchFindings(patch, scoped(root, options), "");
}

export function identityFindings(
  label: string,
  name: string,
  email: string,
  options: Scoped,
): ReadonlyArray<Finding> {
  const noreply = checkIdentity(email);
  const out: Finding[] = noreply
    ? []
    : [{ classId: "commit-identity", source: label, line: 0, rule: "public:noreply-identity" }];
  // A noreply address carries the public platform login, which is allowed by definition.
  const meta = scanText(noreply ? name : `${name} <${email}>`, {
    source: label,
    surface: "commit-metadata",
    denylist: options.denylist,
    policy: options.policy,
  });
  return [...out, ...meta.map((finding) => ({ ...finding, line: 0 }))];
}

/** One commit message: its text, then the emails of its trailers. */
export function messageFindings(
  message: string,
  source: string,
  options: ScanOptions,
): ReadonlyArray<Finding> {
  const out: Finding[] = [
    ...scanText(message, { source, surface: "history", denylist: options.denylist }),
  ];
  for (const trailer of trailerEmails(message)) {
    if (checkTrailerEmail(trailer.email)) continue;
    if (isNeutralAgentTrailer(trailer.name, trailer.email)) continue;
    out.push({
      classId: "commit-identity",
      source,
      line: trailer.line,
      rule: "public:trailer-email",
    });
  }
  return out;
}

function tagFindings(root: string, commits: ReadonlySet<string>, options: Scoped): Finding[] {
  const out: Finding[] = [];
  const refs = git(root, [
    "for-each-ref",
    "refs/tags",
    "--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(refname)",
  ]);
  for (const row of refs.split("\n").filter(Boolean)) {
    const [oid = "", type = "", peeled = "", refname = ""] = row.split("\0");
    if (!commits.has(type === "tag" ? peeled : oid)) continue;
    const label = `tag@${oid.slice(0, 12)}`;
    for (const finding of scanName(refname, "tag", { ...options, surface: "commit-metadata" })) {
      out.push({ ...finding, source: label });
    }
    if (type !== "tag") continue;
    const body = git(root, ["cat-file", "tag", oid]);
    const split = body.indexOf("\n\n");
    const header = split < 0 ? body : body.slice(0, split);
    const message = split < 0 ? "" : body.slice(split + 2);
    const tagger = /^tagger (.*)$/m.exec(header)?.[1] ?? "";
    const email = identEmail(tagger) ?? "";
    out.push(
      ...identityFindings(`${label}:tagger`, tagger.replace(/<.*$/, "").trim(), email, options),
    );
    out.push(...messageFindings(message, `${label}:message`, options));
  }
  return out;
}

/** Every commit in `base..HEAD`: added lines, new paths, message, identities, and tags. */
export function scanRange(
  root: string,
  baseSha: string,
  options: ScanOptions,
): ReadonlyArray<Finding> {
  const opts = scoped(root, options);
  const log = git(root, [
    "log",
    "--reverse",
    "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e",
    `${baseSha}..HEAD`,
  ]);
  const out: Finding[] = [];
  const commits = new Set<string>();
  for (const record of log.split("\x1e")) {
    const [sha = "", an = "", ae = "", cn = "", ce = "", message = ""] = record
      .replace(/^\n/, "")
      .split("\0");
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    commits.add(sha);
    const short = sha.slice(0, 12);
    const patch = git(root, [
      "show",
      "--format=",
      "--diff-merges=first-parent",
      ...PATCH_ARGS,
      sha,
    ]);
    out.push(...patchFindings(patch, opts, `${short}:`));
    out.push(...messageFindings(message, `${short}:message`, opts));
    out.push(...identityFindings(`${short}:author`, an, ae, opts));
    out.push(...identityFindings(`${short}:committer`, cn, ce, opts));
  }
  out.push(...tagFindings(root, commits, opts));
  return out;
}
