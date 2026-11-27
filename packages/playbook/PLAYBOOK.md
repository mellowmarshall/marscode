# Agent-ready repo playbook

Best-practice engineering guidance and evidence standards for repos built in parallel by AI agents.

The playbook does **not** run checks, lint source files, or scan code itself. For each applicable section, a repo declares its system in `playbook.json`, enforces compliance through **code chokes** and deterministic **generation**, and emits structured **evidence** proving its own checks passed.

---

## 0. Terms

| Term                 | Means                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| **Contract**         | A committed declaration in `playbook.json` paired with repo check evidence (§1).                          |
| **Choke**            | A single typed/linted API or factory forcing code to self-declare without scanning (§4).                  |
| **Evidence**         | Structured pass/fail/measurement output emitted by a repo's own checks.                                   |
| **Scoped exception** | An explicit allowlisted `file`/`subject` with technical reason and approval `#N` (never a bulk baseline). |
| **Override**         | `HOST_GUARD_OVERRIDE="<reason>"` for owner-approved loosening or exception changes.                       |
| **UNPROVEN**         | Evidence missing, stale, skipped, or unable to prove a pass; never treated as passing.                    |

---

## 1. Contracts, Growth & Scoped Exceptions

- **1.1 Three criteria:** A contract requires (1) a committed declaration of repo facts, (2) a repo-owned gate emitting structured evidence, and (3) a concrete failure mode it prevents.
- **1.2 No baselines:** Do not maintain bulk `baseline` debt files. Fix violations or declare a narrow scoped exception.
- **1.3 Scoped exceptions per section:** Every section supports an explicit allowlist/exception entry (`file`/`subject`, concrete reason, open issue `#N`) or a host-level waiver in `host-guards/exceptions.json`.
- **1.4 Fixed per-unit caps and invariants:** Keep per-unit limits and scale-invariant checks constant as the repo grows (no N+1s, no full scans, `<= 500` LOC, 100% choke coverage).
- **1.5 Bounded sprawl:** Every new `env` var, `role`, `store`, `dep`, `exception`, or budget increase must state a concrete `why`, confirm existing config/routes cannot serve, and stay within justified scope. Removing a check class or weakening safety invariants requires `HOST_GUARD_OVERRIDE`.
- **1.6 Evidence:** `playbook.json` declares applicable sections (or scoped exceptions); repo evidence covers the current tree cleanly without mutating the checkout.

---

## 2. Ship queue

- **2.1 Queue path:** Merge exclusively via `ship-queue submit/watch` from clean `/data` worktrees against open stamped issues (`Closes #N`). Keep PRs flat (no stacked chains, no tracked scratch/plan files). Consecutive identical gate failures require an explicit `## Premise` (`Premise:`, `Test:`, `Result:`).
- **2.2 The reviewer (`playbook challenge`):** Evaluates the PR strictly against this playbook (`§0–§15`), never as a general code reviewer. May inspect the codebase to confirm scoped exceptions, justified growth/budget rises, file sizes and no-seam splits (catching syntax compacting), choke integrity, CI optimization, and evidence honesty. Cite the exact playbook section and item number (e.g., `§3.3`, `§14.1`) for every violation or playbook-friction finding so the submitter can read that guidance directly. Comment on code bugs **only** when a **breaking, critical, or high** bug or vulnerability is found on a production path (no medium/low nits, style remarks, or non-production edge cases unless gaming a gate). Submitter fixes real production bugs and escalates behavior-altering trade-offs to the owner.
- **2.3 Evidence:** Clean preflight and base-pinned serialized CI/merge pass records matching the tree hash.

---

## 3. File size ratchet

- **3.1 Domain-seam splits (`<= 500` lines):** Keep application source files `<= 500` formatted code lines by splitting along **domain seams** (`*Sql.ts`, `*Wire.ts`, `*Catalog.ts`, `*Types.ts`), never into generic `utils`/`helpers`/`misc`/`common` fragments. Whenever splitting a file that exceeded 500 lines, explicitly name the logical domain seam used for the split in the PR body or commit message and record `{file, seam}` in `size` evidence `measurements.splitFiles` so review and automated checks verify cohesion rather than arbitrary slicing.
- **3.2 No-seam exception (`allowlist`):** If a cohesive state machine, parser, or protocol module has no clean seam, except it explicitly via the repo's size allowlist (`file`, reason, `#N`) after extracting auxiliary queries, serializers, and lookups.
- **3.3 No syntax compacting:** Do not collapse line breaks, chain dense ternaries, or cram logic onto single lines to stay under 500 lines.
- **3.4 Evidence:** Repo size check evidence measured on formatted code or AST statement density, confirming files stay `<= 500` lines or match a valid scoped exception.

---

## 4. Declarations and generations

- **4.1 Chokes and single-DAG generation:** Author architectural facts once and force code to declare itself through **chokes** paired with deterministic generators, rather than regex/AST scanners.
  - _Acceptable example private-repo:_ `fleet-shape.json` and code chokes generate `apps/api/src/fleetEnv.ts` (`readFleetEnv`), `config/workers/roles.ts`, `docker-compose.yml`, and `feature-surfaces.json` in one DAG. ESLint forbids raw `process.env` reads outside the generated choke, and `pnpm generate --check` fails any commit where code and declarations drift.
  - _Bad:_ Reading `process.env.*` across 40 handlers and maintaining a custom regex scanner to guess env usage.
- **4.2 Where Else Chokes Replace Scanners:**

| Domain                      | Single Code Choke (+ Lint Ban on Raw Use)                                 | Emitted Artifact / Evidence (Replaces Scanner)                                                      |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Routes & APIs**           | `defineRoute` / typed router mount requiring path, auth, schema           | Generates `feature-surfaces.json` + client types (`surface` parser gone)                            |
| **Env Vars & Secrets**      | Typed generated reader private-repo `readFleetEnv` (`fleetEnv.ts`)          | Exact env reads known at compile/gen time (`pb_fleet_reads` / regexes gone)                         |
| **UI Controls & Actions**   | `packages/ui` requiring `actionId: ActionId` + `controls-boundary` ESLint | Self-registers `client-actions.json`; test runtime logs fired IDs (`pb_actions_scan.mjs` gone)      |
| **Design Tokens & Styles**  | Shared `tokens` + lint banning hex/spacing literals outside tokens        | Lint pass proves compliance (`11` `pb_design_*.mjs` files gone)                                     |
| **Background Jobs / Crons** | `defineJob({ name, queue, schedule, sla })` wrapper                       | Emits `fleet-shape.json` worker roles + automatic job timing/metrics                                |
| **DB Access & Migrations**  | Typed DB client/query wrapper + migration runner hook                     | Emits query count / full-scan receipts directly (`pb_sql.py` / `pb_migrations.py` SQL ASTs gone)    |
| **Storage Buckets & KV**    | `defineBucket` / `defineKV` wrapper                                       | Declares buckets, prefixes, TTLs directly instead of scanning string literals                       |
| **Vendor / HTTP Clients**   | `createVendorClient('fly' \| 'stripe' \| ...)` factory                    | Registers egress vendors, timeouts, retries, and secrets automatically                              |
| **CI Suites / Harnesses**   | `runTier` / `runSuite` runner wrapper                                     | Emits tier wall time, work budgets, setup vs test duration, and pass receipt (`pb_ci_scan.py` gone) |
| **Feature Capabilities**    | `defineFeature` capability registry                                       | Drives `user`/`admin` product doc triggers deterministically                                        |

- **4.3 Evidence:** Repo generation `--check` pass receipt proving zero drift between code chokes, JSON declarations, and generated artifacts, plus any scoped exceptions.

---

## 5. Contract changes

- **5.1 Explicit change intent:** Make every addition, removal, or modification of a contract item (`surface`, `fleet`, `dictionary`, `actions`, `slots`) explicit and justified (`## Contract Intent` or choke-derived diff summary + concrete reason; never vague filler like _"needed"_).
- **5.2 Breaking or silent sprawl:** Silent surface/schema sprawl or unapproved breaking removals fail review.
- **5.3 Evidence:** Repo/change diff matches declared contract-change explanations cleanly, or falls under a valid scoped exception.

---

## 6. Fleet shape

- **6.1 Single infrastructure declaration:** Maintain `fleet-shape.json` as the authoritative declaration for apps, hosts, worker roles, env vars, secret rotation, stores, queues, vendor clients, and mobile releases.
- **6.2 Choked env, ports, and secrets:** Enforce env/port/vendor usage through typed chokes; never bake secrets into images/configs or hardcode dev host ports.
- **6.3 Live drift (`Full CI`):** Pre-release (`Full CI`), verify declared cloud resources match live providers.
- **6.4 Evidence:** Repo static fleet/choke check evidence (and live-provider drift check evidence on `Full CI`), plus any scoped exceptions.

---

## 7. DB dictionary

- **7.1 Complete schema metadata:** Document every table, column, owner, retention policy, PII flag, and canonical concept alongside schema definitions.
- **7.2 Migrations and snapshot:** Author schema changes solely via migrations and maintain a committed schema snapshot (`snapshot --write`).
- **7.3 Evidence:** Repo dictionary coverage and incremental snapshot-replay evidence, plus any scoped exceptions (`-- schema-ok #N` or allowlist).

---

## 8. Destructive gates

- **8.1 Data and uniqueness protection:** Never drop tables, columns, primary/unique constraints, or enum values, and never rewrite merged migrations without explicit owner-issue approval (`-- destructive-ok #N`).
- **8.2 Evidence:** Repo migration lint evidence confirming zero unapproved destructive DDL changes.

---

## 9. User actions catalog

- **9.1 Choked action catalog:** Catalog interactive controls (`widget` and `journey` actions) via UI chokes requiring `actionId: ActionId`, and prove real end-to-end user outcomes without mocking out the path under test or asserting empty layout containers.
- **9.2 Repo evidence:** Repo test/walk evidence proving catalogued controls fire and observe real outcomes (with scoped exceptions such as `standalone`, `device`, or `host-guards/exceptions.json` `9/Repo evidence`).

---

## 10. Design rules

- **10.1 Token and UI package confinement:** Confine colors, typography, spacing, and interactive primitives to the shared UI package (`ui`) and design tokens via lint/type chokes (e.g., `exp`'s `private-repo` ESLint rule banning raw `<button>`/`Pressable`/`onClick` outside `src/ui`).
- **10.2 Evidence:** Repo design-choke check evidence confirming compliance, plus any scoped exceptions (`content_values`, `system`, allowlist).

---

## 11. Optimization budgets

- **11.1 Instrumented budgets:** Track route and background-job efficiency budgets (round trips, query shape/amplification, payload/bundle size, caching, cancellation, external timeouts, optional wall-time bounds) via instrumented client/DB wrappers rather than ad-hoc scripts.
- **11.2 No waste regressions:** Prevent N+1 queries, unindexed full scans, duplicate fetches, and query-splitting games; any budget increase must cite real feature scope and pass review (large jumps or ceiling breaks require `HOST_GUARD_OVERRIDE`).
- **11.3 Evidence:** Budget declarations paired with fresh measurement receipts (committed or merge-gate pass records) within budget/justified bounds, or an explicit scoped exception (`none` / `notApplicable`).

---

## 12. System maps

- **12.1 Live self-describing maps:** Maintain interactive, self-describing architecture maps (`fleet`, `routes`, `db`, `actions`, `jobs`) continuously from codebase chokes and generated declarations—never stale post-merge HTML files—so agents and humans can inspect repo structure and flows directly at any time.
- **12.2 Evidence:** Declaration/map index stays valid and synchronized with choke-generated artifacts on every change.

---

## 13. Declared checks & Dead code

- **13.1 Active stack coverage:** Cover every active source language with real linting, typechecking, dependency security, and dead-code checks—never skipped or non-failing stubs.
- **13.2 Routine PR dead code:** Fail local unused code introduced or orphaned inside touched files (unused locals, imports, private helpers).
- **13.3 Full CI dead-code cleanup:** Run full-repo cross-module dead-code analysis anchored on choke entrypoints, gated by age or issue state (ignore brand-new staged work `< 14` days old or linked to an open `#N`; fail stale unreferenced modules, unused env vars, and dead routes so old code gets deleted).
- **13.4 Evidence:** Repo check evidence confirming each declared check ran honestly on the current tree and passed, plus any scoped exceptions (`python_external` / tool allowlist).

---

## 14. CI standards and execution tiers

- **14.1 Every check earns its place:** Keep only checks that prove a core path end-to-end or stop named damage no other layer catches. When cutting a check that fails to earn its place, delete its dedicated setup and fixtures too, and judge results in suite wall time rather than check count.
- **14.2 Fast, parallel, isolated:** Replace hardcoded `sleep` timers with condition predicates (`wait_for`), boot test DBs from the committed snapshot instead of replaying full migration history, and prepare schema once per run with per-test transaction rollbacks or worker-isolated schemas. Partition suites into adaptive diff-selected parallel tiers (`Tier 1 < 60s`, `Tier 2 < 3m`, `Tier 3 < 5m`, or declared deterministic work budgets). Time every CI step and suite explicitly; break down longer stages (`> 30s`) into granular sub-step timings (compile/build, dependency/DB setup, fixtures/seeding, test execution, teardown) so bottlenecks are immediately actionable.
- **14.3 Evidence:** Repo CI evidence recording selected suites, per-step and per-suite timings (with granular sub-step breakdowns for any stage `> 30s`), tier timings/work counts within bounds, setup-vs-test time breakdown, `Every check earns its place` compliance, and any scoped exceptions.

---

## 15. Product docs

- **15.1 Triggered doc sync:** Opt-in tracking (`contracts.docs`) linking feature/capability registries (`user` and `admin` docs) so product documentation updates alongside surface or capability changes.
- **15.2 Evidence:** Repo docs check evidence confirming non-empty declared docs stayed synced with triggered changes (or valid scoped exceptions).
