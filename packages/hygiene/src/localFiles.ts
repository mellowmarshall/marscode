/** PLAYBOOK §16.2 `local-only-files`: tracked paths that must stay local, and ignore coverage. */
import { gitStatus } from "./gitRead.ts";
import type { Finding } from "./hygieneTypes.ts";

const FIXTURE_DIR = /(^|\/)(fixtures?|__fixtures__|test-fixtures|testdata)\//;

const TRACKED_RULES: ReadonlyArray<{ readonly id: string; readonly test: (p: string) => boolean }> =
  [
    {
      id: "tracked-env",
      test: (p) => /(^|\/)\.env(\.|$)/.test(p) && !/\.(example|sample|template)$/.test(p),
    },
    { id: "tracked-agent-settings", test: (p) => /(^|\/)\.claude\/settings\.local\.json$/.test(p) },
    { id: "tracked-plans", test: (p) => /(^|\/)plans\//.test(p) },
    { id: "tracked-log", test: (p) => p.endsWith(".log") },
    {
      id: "tracked-database",
      test: (p) => /\.(sqlite3?|db)(-wal|-shm|-journal)?$/.test(p) && !FIXTURE_DIR.test(p),
    },
    {
      id: "tracked-fleet-declaration",
      test: (p) => p === "fleet-shape.json" || p === "ci-hosts.json",
    },
  ];

/** A sample path per local-only kind; `.gitignore` must ignore each. */
const IGNORE_SAMPLES: ReadonlyArray<{ readonly id: string; readonly path: string }> = [
  { id: "ignore-env", path: ".env" },
  { id: "ignore-env", path: ".env.local" },
  { id: "ignore-agent-settings", path: ".claude/settings.local.json" },
  { id: "ignore-plans", path: "plans/hygiene-sample.md" },
  { id: "ignore-fleet-shape", path: "fleet-shape.json" },
  { id: "ignore-ci-hosts", path: "ci-hosts.json" },
];

export function localOnlyPathFindings(path: string): ReadonlyArray<Finding> {
  return TRACKED_RULES.filter((rule) => rule.test(path)).map((rule) => ({
    classId: "local-only-files",
    source: path,
    line: 0,
    rule: `public:${rule.id}`,
  }));
}

/** Ignore rules that fail to cover a local-only kind, checked with `git check-ignore`. */
export function ignoreCoverageFindings(root: string): ReadonlyArray<Finding> {
  const out: Finding[] = [];
  const reported = new Set<string>();
  for (const sample of IGNORE_SAMPLES) {
    if (reported.has(sample.id)) continue;
    if (gitStatus(root, ["check-ignore", "-q", "--no-index", "--", sample.path]) === 0) continue;
    reported.add(sample.id);
    out.push({
      classId: "local-only-files",
      source: ".gitignore",
      line: 0,
      rule: `public:${sample.id}`,
    });
  }
  return out;
}
