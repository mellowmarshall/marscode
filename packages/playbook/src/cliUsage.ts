/** The `playbook` command line's usage text and its argument-choice refusals. */

export const USAGE = `usage: playbook [-C DIR] <command>
  check [contract...] [--trigger every|paths|full] [--pr-body FILE] [--ship] [--json]
                                                  validate playbook.json and repo-emitted playbook-evidence/v1 receipts
  challenge [--base REF] [--tip REF] [--response FILE] [--out FILE] [--advisory] [--json]
                                                  the declaration challenge on the real worktree
  amend <PLAYBOOK.md> [TEXT_FILE] [--base REF] [--issue #N] [--collect]
                                                  amend the standards under the owner's override
  init [--dry-run]                                write the minimal evidence-only playbook.json
  minimal [--merge JSON]                          print the minimal valid playbook.json
  db-dict <term>                                  find the dictionary's concepts, tables and columns
  intent-diff [--base REF] [--contract NAME]... [--json]
                                                  the contract changes intent would judge
  intent-audit --base SHA --merged SHA [--body FILE]
                                                  one record per declared contract change
  ci-files [--rev REV]                            the CI files the size checks exempt (PLAYBOOK §3), one per line
  actions required [--base REF] [--mode merge-gate|evidence|all]
                                                  the walks a change must run, one per line (PLAYBOOK §9)
  stats [--side S] [--by G] [--source S] [--repo R] [--lab L] [--days N] [--include-bypasses] [--json]
                                                  review verdict statistics
  version                                         print the host playbook version

Every command takes -C DIR (default: the current directory's repo).
Exit codes: 0 pass, 1 fail, 2 usage, 3 nothing failed but something is UNPROVEN.`;

export const SUBCOMMAND_USAGE: Readonly<Record<string, string>> = {
  check:
    "usage: playbook [-C DIR] check [contract...] [--trigger every|paths|full] [--pr-body FILE] [--ship] [--json]\n  validate playbook.json and repo-emitted playbook-evidence/v1 receipts (--ship and --trigger accepted for compatibility; validation is always strict and covers every declared contract)",
  challenge:
    "usage: playbook [-C DIR] challenge [--base REF] [--tip REF] [--response FILE] [--out FILE] [--advisory] [--json]\n  run the read-only declaration challenge on the real worktree",
  amend:
    "usage: playbook [-C DIR] amend <PLAYBOOK.md> [TEXT_FILE] [--base REF] [--issue #N] [--collect]\n  amend PLAYBOOK.md under the owner's override (TEXT_FILE: a file holding the whole new text, written only once approved)",
  init: "usage: playbook [-C DIR] init [--dry-run]\n  write the minimal evidence-only playbook.json",
  minimal:
    "usage: playbook minimal [--merge JSON]\n  print the minimal valid playbook.json (JSON object of contracts merged into it: an object merges, null removes)",
  "db-dict":
    "usage: playbook [-C DIR] db-dict <term>\n  search the DB dictionary's concepts, tables and columns",
  "intent-diff":
    "usage: playbook [-C DIR] intent-diff [--base REF] [--contract NAME]... [--json]\n  the contract changes playbook check intent would judge",
  "intent-audit":
    "usage: playbook [-C DIR] intent-audit --base SHA --merged SHA [--body FILE]\n  the post-merge record of each declared contract change (body default: SHIP_QUEUE_BODYFILE)",
  "ci-files":
    "usage: playbook [-C DIR] ci-files [--rev REV]\n  the CI files the size checks exempt (PLAYBOOK §3), one per line (default rev: HEAD)",
  stats:
    "usage: playbook stats [--side S] [--by G] [--source S] [--repo R] [--lab L] [--days N] [--include-bypasses] [--json]\n  show review verdict statistics",
  version: "usage: playbook version\n  print the host playbook version",
};

/** The refusal for a VALUE of FLAG outside CHOICES, as the original's parser words it; null when it is one. */
export function choiceError(
  command: string,
  flag: string,
  value: string | undefined,
  choices: ReadonlyArray<string>,
): string | null {
  if (value === undefined || choices.includes(value)) return null;
  return `playbook ${command}: error: argument ${flag}: invalid choice: '${value}' (choose from ${choices.map((c) => `'${c}'`).join(", ")})`;
}
