// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info has no ctime or sub-millisecond mtime, which the cache tests compare.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { parseRateTable, priceUsage } from "../../usage/usagePricing.ts";

import { makeAntigravityUsageCache, readAntigravityUsage } from "./antigravityUsageReader.ts";

const openDatabase = Effect.fn("openDatabase")(function* (filename: string) {
  const context = yield* Layer.build(NodeSqliteClient.layer({ filename }));
  const sql = Context.get(context, SqlClient.SqlClient);
  return {
    exec: (statement: string) => sql.unsafe(statement),
    run: (statement: string, params: ReadonlyArray<unknown>) => sql.unsafe(statement, params),
  };
});

const seedDatabase = <E>(
  filename: string,
  seed: (db: Effect.Success<ReturnType<typeof openDatabase>>) => Effect.Effect<void, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed(yield* openDatabase(filename));
    }),
  );

const tempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
});

function protoNumber(field: number, value: number): number[] {
  const varint = (number: number) => {
    const bytes: number[] = [];
    do {
      const byte = number % 128;
      number = Math.floor(number / 128);
      bytes.push(byte + (number > 0 ? 128 : 0));
    } while (number > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
}

function protoBytes(field: number, bytes: readonly number[]): number[] {
  const encoded = protoNumber(field, bytes.length);
  encoded[0] = encoded[0]! + 2;
  return [...encoded, ...bytes];
}

function protoText(field: number, value: string): number[] {
  return protoBytes(field, [...Buffer.from(value)]);
}

const TABLES =
  "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)";

const createTables = (db: Effect.Success<ReturnType<typeof openDatabase>>) =>
  Effect.forEach(TABLES.split("; "), db.exec, { discard: true });

const records = (result: Effect.Success<ReturnType<typeof readAntigravityUsage>>) =>
  result.files.flatMap((file) => file.records);

describe("readAntigravityUsage", () => {
  it.effect("learns numeric models from offline metadata and refreshes cached resolutions", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* tempDir;
      const cache = makeAntigravityUsageCache();
      yield* seedDatabase(path.join(dir, "a-usage.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, id] of [9001, 9002, 1319].entries()) {
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(9, [...protoNumber(1, id), ...protoNumber(2, 10)])),
            ]);
          }
        }),
      );
      const first = yield* readAntigravityUsage(dir, 0, cache);
      assert.strictEqual(records(first)[0]?.model, "antigravity-model-9001");
      const evidence = path.join(dir, "z-names.db");
      yield* seedDatabase(evidence, (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, [id, name]] of (
            [
              [9001, "Gemini 9.1 Flash (High)"],
              [9002, "Gemini default"],
              [1319, "Gemini 9.2 Flash"],
            ] as const
          ).entries()) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              new Uint8Array(
                protoBytes(1, [
                  ...protoNumber(3, id),
                  ...protoText(19, "gemini-default"),
                  ...protoText(21, name),
                ]),
              ),
            ]);
          }
        }),
      );
      const next = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        records(next).map(({ model, rateModel }) => [model, rateModel]),
        [
          ["gemini-9.1-flash-high", "gemini-9.1-flash"],
          ["antigravity-model-9002", undefined],
          ["gemini-9.2-flash", undefined],
        ],
      );
      assert.deepStrictEqual(records(yield* readAntigravityUsage(dir, 0, cache)), records(next));
      yield* fs.remove(evidence);
      assert.deepStrictEqual(records(yield* readAntigravityUsage(dir, 0, cache)), records(first));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps explicit model evidence separate from retries and conflicting names", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "conflicts.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, name] of ["Gemini 9.1 Flash", "Gemini 9.2 Flash"].entries()) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              new Uint8Array(
                protoBytes(1, [
                  ...protoNumber(3, 1319),
                  ...protoText(19, name),
                  ...protoBytes(4, [
                    ...protoNumber(1, 1319),
                    ...protoNumber(2, 10),
                    ...protoText(11, `r-${idx}`),
                  ]),
                  ...protoBytes(
                    17,
                    protoBytes(2, [...protoNumber(1, 1026), ...protoNumber(2, 12)]),
                  ),
                ]),
              ),
            ]);
          }
          for (const [idx, id] of [1319, 9003].entries()) {
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              10 + idx,
              new Uint8Array(
                protoBytes(9, [
                  ...protoNumber(1, id),
                  ...protoNumber(2, 10),
                  ...(idx === 0 ? protoText(11, "r-0") : []),
                ]),
              ),
            ]);
          }
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            2,
            new Uint8Array(protoBytes(9, [...protoNumber(1, 1319), ...protoNumber(2, 10)])),
          ]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            3,
            new Uint8Array(
              protoBytes(1, [
                ...protoText(19, "Gemini 9.3 Flash"),
                ...protoBytes(17, protoBytes(2, [...protoNumber(1, 9004), ...protoNumber(2, 10)])),
              ]),
            ),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            4,
            new Uint8Array([
              ...protoBytes(24, protoText(12, "Claude 5.5 Opus (Thinking)")),
              ...protoBytes(9, [...protoNumber(1, 9005), ...protoNumber(2, 10)]),
            ]),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result)
          .map(({ model }) => model)
          .sort(),
        [
          "gemini-9.1-flash",
          "antigravity-model-9003",
          "antigravity-model-1319",
          "claude-opus-4-6",
          "gemini-9.2-flash",
          "claude-opus-4-6",
          "antigravity-model-9004",
          "claude-opus-5-5-thinking",
        ].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "deduplicates Antigravity generation and step usage while preserving retry model and token buckets",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const stamp = protoNumber(1, 1780000000);
        const usage = [
          ...protoNumber(2, 100),
          ...protoNumber(3, 40),
          ...protoNumber(4, 5),
          ...protoNumber(5, 20),
          ...protoNumber(9, 10),
          ...protoText(11, "response-1"),
        ];
        const retry = [
          ...protoNumber(1, 1026),
          ...protoNumber(2, 12),
          ...protoNumber(3, 3),
          ...protoText(11, "retry-1"),
        ];
        const generation = protoBytes(1, [
          ...protoBytes(4, usage),
          ...protoText(19, "Gemini 3 Pro"),
          ...protoBytes(9, protoBytes(4, stamp)),
        ]);
        const step = [
          ...protoBytes(9, usage),
          ...protoBytes(8, stamp),
          ...protoBytes(28, protoBytes(2, retry)),
        ];
        yield* seedDatabase(path.join(dir, "session-1.db"), (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              0,
              new Uint8Array(generation),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [0, new Uint8Array(step)]);
          }),
        );
        const result = yield* readAntigravityUsage(dir, 0);
        assert.deepStrictEqual(result.errors, []);
        const read = records(result);
        assert.strictEqual(read.length, 2);
        const main = read.find((record) => record.model === "gemini-3-pro");
        assert.isDefined(main);
        assert.strictEqual(main?.timestampMs, 1780000000000);
        assert.strictEqual(main?.sessionId, "session-1");
        assert.deepStrictEqual(main?.totals, {
          uncachedInputTokens: 100,
          cachedInputTokens: 20,
          cacheCreationTokens: 5,
          outputTokens: 40,
          reasoningTokens: 10,
        });
        assert.strictEqual(
          read.find((record) => record.model === "claude-opus-4-6")?.totals.uncachedInputTokens,
          12,
        );
        assert.deepStrictEqual(records(yield* readAntigravityUsage(dir, 1780000000001)), []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the matching Antigravity generation model for each model-less step", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "model-switch.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, name] of ["Gemini 3 Pro", "Claude Opus 4.6"].entries()) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(1, protoText(19, name))),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))),
            ]);
          }
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((record) => record.model),
        ["gemini-3-pro", "claude-opus-4-6"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prices Antigravity effort and routing variants at their base model", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "variants.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(1, protoText(19, "Gemini 3.7 Flash Control"))),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, protoNumber(2, 10))),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            1,
            new Uint8Array(protoBytes(9, [...protoNumber(1, 1319), ...protoNumber(2, 11)])),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            2,
            new Uint8Array(protoBytes(9, [...protoNumber(1, 1132), ...protoNumber(2, 12)])),
          ]);
          // A model-less step that only learns its model by merging with a named generation.
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            5,
            new Uint8Array(protoBytes(9, [...protoNumber(2, 100), ...protoText(11, "response")])),
          ]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            3,
            new Uint8Array(
              protoBytes(1, [
                ...protoText(19, "Gemini 3.8 Flash High"),
                ...protoBytes(4, [...protoNumber(2, 100), ...protoText(11, "response")]),
              ]),
            ),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((record) => [record.model, record.rateModel]),
        [
          ["gemini-3.7-flash-control", "gemini-3.7-flash"],
          ["gemini-3.8-flash-medium", "gemini-3.8-flash"],
          ["gemini-3.5-flash-high", "gemini-3.5-flash"],
          ["gemini-3.8-flash-high", "gemini-3.8-flash"],
        ],
      );
      const table = parseRateTable({
        "gemini-3.7-flash": { input_cost_per_token: 0.75e-6, output_cost_per_token: 3.75e-6 },
        "gemini-3.8-flash": { input_cost_per_token: 0.75e-6, output_cost_per_token: 3.75e-6 },
        "gemini-3.5-flash": { input_cost_per_token: 0.5e-6, output_cost_per_token: 3e-6 },
      });
      const priced = records(result).map((record) => priceUsage(table, record));
      assert.deepStrictEqual(
        priced.map(({ costSource }) => costSource),
        Array(4).fill("modelPriced"),
      );
      for (const [index, expected] of [7.5e-6, 8.25e-6, 6e-6, 75e-6].entries()) {
        assert.closeTo(priced[index]!.costUsd, expected, 1e-12);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prices ACP effort variants at the base model rate", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "effort.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          for (const [idx, name] of [
            "gemini-4-argon-high",
            "gemini-4-argon",
            "gemini-3.7-flash-safety-le",
            "gemini-3-flash-agent",
            "gemini-3-flash",
            "gemini-default",
            "gemini-pro-orchestrator-neon",
            "gemini-4-hydrogen-orchestrator",
            "gemini-pro-orchestrator-g1-pro",
          ].entries()) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(1, protoText(19, name))),
            ]);
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              idx,
              new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))),
            ]);
          }
          // Orchestrator (Neon), MODEL_PLACEHOLDER_M537, with no name in the metadata.
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            20,
            new Uint8Array(protoBytes(9, [...protoNumber(1, 1537), ...protoNumber(2, 30)])),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(
        records(result).map(({ model, rateModel }) => [model, rateModel]),
        [
          ["gemini-4-argon-high", "gemini-4-argon"],
          ["gemini-4-argon", undefined],
          ["gemini-3.7-flash-safety-le", "gemini-3.7-flash"],
          ["gemini-3-flash-agent", "gemini-3.5-flash"],
          ["gemini-3-flash", "gemini-3-flash-preview"],
          ["gemini-default", undefined],
          ["gemini-pro-orchestrator-neon", "gemini-4-neon"],
          ["gemini-4-hydrogen-orchestrator", "gemini-4-hydrogen"],
          ["gemini-pro-orchestrator-g1-pro", "gemini-4-argon"],
          ["gemini-pro-orchestrator-neon", "gemini-4-neon"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges Antigravity aliases that bridge previously separate step records", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "bridge.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, [...protoNumber(2, 100), ...protoText(11, "response")])),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            1,
            new Uint8Array(protoBytes(9, [...protoNumber(3, 40), ...protoText(12, "provider")])),
          ]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            new Uint8Array(
              protoBytes(1, [
                ...protoText(19, "Gemini 3 Pro"),
                ...protoBytes(4, [
                  ...protoNumber(2, 50),
                  ...protoNumber(5, 20),
                  ...protoText(11, "response"),
                  ...protoText(12, "provider"),
                ]),
              ]),
            ),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      const read = records(result);
      assert.strictEqual(read.length, 1);
      assert.deepStrictEqual(read[0]?.totals, {
        uncachedInputTokens: 100,
        cachedInputTokens: 20,
        cacheCreationTokens: 0,
        outputTokens: 40,
        reasoningTokens: 0,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "merges Antigravity provider and message aliases across configured roots while keeping original ownership",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        const roots = [path.join(dir, "first"), path.join(dir, "second")];
        for (const [index, root] of roots.entries()) {
          yield* fileSystem.makeDirectory(root);
          yield* seedDatabase(path.join(root, `session-${index}.db`), (db) =>
            Effect.gen(function* () {
              yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
              for (const identity of [7, 12]) {
                const usage = [
                  ...protoNumber(1, 246),
                  ...protoNumber(2, index === 0 ? 100 : 150),
                  ...protoText(11, `response-${index}-${identity}`),
                  ...protoText(identity, `shared-${identity}`),
                ];
                yield* db.run("INSERT INTO steps VALUES (?, ?)", [
                  identity,
                  new Uint8Array(protoBytes(9, usage)),
                ]);
              }
            }),
          );
        }
        const result = yield* readAntigravityUsage(roots, 0);
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.files.length, 2);
        assert.strictEqual(result.files[0]?.root, roots[0]);
        assert.strictEqual(result.files[0]?.records.length, 2);
        assert.strictEqual(result.files[1]?.records.length, 0);
        assert.deepStrictEqual(
          result.files[0]?.records.map((record) => record.totals.uncachedInputTokens),
          [150, 150],
        );
        assert.isTrue(result.files[0]?.records.every((record) => record.sessionId === "session-0"));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("upgrades Antigravity fallback timestamps before applying the date window", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      for (const fallback of ["mtime", "trajectory"]) {
        const file = path.join(dir, `${fallback}.db`);
        yield* seedDatabase(file, (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            if (fallback === "trajectory") {
              yield* db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
              yield* db.run("INSERT INTO trajectory_metadata_blob VALUES (?)", [
                new Uint8Array(protoBytes(2, protoNumber(1, 1780000200))),
              ]);
            }
            for (const [index, seconds] of [1780000000, 1780000200].entries()) {
              const usage = [...protoNumber(2, 10), ...protoText(11, `${fallback}-${index}`)];
              yield* db.run("INSERT INTO steps VALUES (?, ?)", [
                index,
                new Uint8Array(protoBytes(9, usage)),
              ]);
              yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
                index,
                new Uint8Array(
                  protoBytes(1, [
                    ...protoBytes(4, usage),
                    ...protoBytes(9, protoBytes(4, protoNumber(1, seconds))),
                  ]),
                ),
              ]);
            }
          }),
        );
        yield* fileSystem.utimes(file, 1780000000, 1780000000);
      }
      const result = yield* readAntigravityUsage(dir, 1780000100000);
      assert.deepStrictEqual(result.errors, []);
      const read = records(result);
      assert.strictEqual(read.length, 2);
      assert.deepStrictEqual(
        read.map((record) => record.timestampMs),
        [1780000200000, 1780000200000],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const antigravityGeneration = (responseId: string) =>
    new Uint8Array(
      protoBytes(1, [
        ...protoBytes(4, [
          ...protoNumber(2, 100),
          ...protoNumber(3, 40),
          ...protoText(11, responseId),
        ]),
        ...protoText(19, "Gemini 3 Pro"),
        ...protoBytes(9, protoBytes(4, protoNumber(1, 1780000000))),
      ]),
    );

  it.effect("rereads an Antigravity database when only its WAL changed", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const dir = yield* tempDir;
      const path = pathService.join(dir, "session-1.db");
      const db = yield* openDatabase(path);
      yield* db.exec("PRAGMA journal_mode = WAL");
      yield* db.exec("PRAGMA wal_autocheckpoint = 0");
      yield* db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      const insert = (idx: number, responseId: string) =>
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", [idx, antigravityGeneration(responseId)]);
      yield* insert(0, "r-1");
      const cache = makeAntigravityUsageCache();
      const first = yield* readAntigravityUsage(dir, 0, cache);
      assert.strictEqual(records(first).length, 1);

      const before = yield* Effect.promise(() => NodeFSP.stat(path));
      yield* insert(1, "r-2");
      const after = yield* Effect.promise(() => NodeFSP.stat(path));
      assert.strictEqual(after.size, before.size);
      assert.strictEqual(after.mtimeMs, before.mtimeMs);

      const next = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        records(next).map((record) => record.dedupeKey),
        ["antigravity:11:r-1", "antigravity:11:r-2"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads Antigravity step-only stores, skips index files and reports malformed databases",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* tempDir;
        // agy 1.5.x keeps this index beside its conversations; it is not a conversation store.
        yield* seedDatabase(path.join(dir, "conversation_summaries.db"), (db) =>
          db.exec(
            "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, step_count INTEGER)",
          ),
        );
        yield* seedDatabase(path.join(dir, "steps.db"), (db) =>
          Effect.gen(function* () {
            yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
            const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...protoNumber(3, 5)];
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              0,
              new Uint8Array([
                ...protoBytes(9, usage),
                ...protoBytes(8, protoNumber(1, 1780000000)),
              ]),
            ]);
          }),
        );
        yield* fileSystem.writeFileString(path.join(dir, "broken.db"), "not a sqlite database");
        const result = yield* readAntigravityUsage(dir, 0);
        assert.deepStrictEqual(result.errors, [path.join(dir, "broken.db")]);
        assert.strictEqual(records(result)[0]?.model, "gemini-2.5-pro");
        assert.strictEqual(records(result)[0]?.totals.outputTokens, 5);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores large values in unused Antigravity protobuf fields", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "large-varint.db"), (db) =>
        Effect.gen(function* () {
          yield* db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
          const unusedField = [...protoNumber(99, 0).slice(0, -1), ...Array(9).fill(0xff), 0x01];
          const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...unusedField];
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, usage)),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(records(result)[0]?.totals.uncachedInputTokens, 10);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const stepUsage = (responseId: string) =>
    new Uint8Array(protoBytes(9, [...protoNumber(2, 10), ...protoText(11, responseId)]));

  it.effect("returns Antigravity records in idx order however the rows are stored", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      yield* seedDatabase(path.join(dir, "session-1.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.exec("BEGIN");
          for (let idx = 99; idx >= 0; idx--) {
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [idx, stepUsage(`s-${idx}`)]);
          }
          for (const idx of [1, 0]) {
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              idx,
              antigravityGeneration(`g-${idx}`),
            ]);
          }
          yield* db.exec("COMMIT");
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((record) => record.dedupeKey),
        [
          ...Array.from({ length: 100 }, (_, idx) => `antigravity:11:s-${idx}`),
          "antigravity:11:g-0",
          "antigravity:11:g-1",
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("filters memoized snapshots across date windows without mutating cached records", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const cache = makeAntigravityUsageCache();
      for (const [name, seconds] of [
        ["old.db", 1780000000],
        ["mid.db", 1780000500],
        ["new.db", 1780001000],
      ] as const) {
        yield* seedDatabase(path.join(dir, name), (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              0,
              new Uint8Array(
                protoBytes(1, [
                  ...protoBytes(4, [...protoNumber(2, 50), ...protoText(11, `r-${name}`)]),
                  ...protoText(19, "Gemini 3 Pro"),
                  ...protoBytes(9, protoBytes(4, protoNumber(1, seconds))),
                ]),
              ),
            ]);
          }),
        );
      }
      const all = yield* readAntigravityUsage(dir, 0, cache);
      assert.strictEqual(records(all).length, 3);
      // Mutating the returned array must not corrupt subsequent memoized reads.
      all.files[0]!.records.pop();
      const mid = yield* readAntigravityUsage(dir, 1780000500000, cache);
      assert.deepStrictEqual(
        records(mid).map((r) => r.sessionId),
        ["mid", "new"],
      );
      const empty = yield* readAntigravityUsage(dir, 1780002000000, cache);
      assert.deepStrictEqual(records(empty), []);
      const restored = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        records(restored).map((r) => r.sessionId),
        ["mid", "new", "old"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("incrementally patches single-DB updates and falls back on cross-file aliases", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const dir = yield* tempDir;
      const cache = makeAntigravityUsageCache();
      const stablePath = pathService.join(dir, "a-stable.db");
      const activePath = pathService.join(dir, "b-active.db");
      yield* seedDatabase(stablePath, (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            antigravityGeneration("s-1"),
          ]);
        }),
      );
      const activeDb = yield* openDatabase(activePath);
      yield* activeDb.exec("PRAGMA journal_mode = WAL");
      yield* activeDb.exec("PRAGMA wal_autocheckpoint = 0");
      yield* activeDb.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      yield* activeDb.run("INSERT INTO gen_metadata VALUES (?, ?)", [
        0,
        antigravityGeneration("a-1"),
      ]);
      const first = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        records(first).map((r) => r.dedupeKey),
        ["antigravity:11:s-1", "antigravity:11:a-1"],
      );
      // Disjoint WAL update hits incremental single-file patch.
      yield* activeDb.run("INSERT INTO gen_metadata VALUES (?, ?)", [
        1,
        antigravityGeneration("a-2"),
      ]);
      const second = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(
        records(second).map((r) => r.dedupeKey),
        ["antigravity:11:s-1", "antigravity:11:a-1", "antigravity:11:a-2"],
      );
      // Introducing a key shared with a-stable.db must fall back to global merge and keep first-file ownership.
      yield* activeDb.run("INSERT INTO gen_metadata VALUES (?, ?)", [
        2,
        new Uint8Array(
          protoBytes(1, [
            ...protoBytes(4, [
              ...protoNumber(2, 250),
              ...protoNumber(3, 40),
              ...protoText(11, "s-1"),
            ]),
            ...protoText(19, "Gemini 3 Pro"),
            ...protoBytes(9, protoBytes(4, protoNumber(1, 1780000000))),
          ]),
        ),
      ]);
      const third = yield* readAntigravityUsage(dir, 0, cache);
      assert.strictEqual(third.files[0]?.records.length, 1);
      assert.strictEqual(third.files[0]?.records[0]?.totals.uncachedInputTokens, 250);
      assert.strictEqual(third.files[0]?.records[0]?.sessionId, "a-stable");
      assert.deepStrictEqual(
        third.files[1]?.records.map((r) => r.dedupeKey),
        ["antigravity:11:a-1", "antigravity:11:a-2"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "skips symlinked databases and directories inside roots while scanning symlinked roots",
    () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const dir = yield* tempDir;
        const realRoot = pathService.join(dir, "real-root");
        const linkedRoot = pathService.join(dir, "linked-root");
        const outside = pathService.join(dir, "outside");
        yield* Effect.promise(() => NodeFSP.mkdir(realRoot));
        yield* Effect.promise(() => NodeFSP.mkdir(outside));
        yield* seedDatabase(pathService.join(realRoot, "real.db"), (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              0,
              antigravityGeneration("r-1"),
            ]);
          }),
        );
        yield* seedDatabase(pathService.join(outside, "ext.db"), (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
              0,
              antigravityGeneration("r-2"),
            ]);
          }),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(
            pathService.join(outside, "ext.db"),
            pathService.join(realRoot, "link.db"),
          ),
        );
        yield* Effect.promise(() =>
          NodeFSP.symlink(outside, pathService.join(realRoot, "linked-subdir")),
        );
        yield* Effect.promise(() => NodeFSP.symlink(realRoot, linkedRoot));
        const result = yield* readAntigravityUsage(linkedRoot, 0);
        assert.deepStrictEqual(result.errors, []);
        assert.deepStrictEqual(
          records(result).map((r) => r.sessionId),
          ["real"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("deduplicates matching step and generation candidates before caching", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const dir = yield* tempDir;
      const cache = makeAntigravityUsageCache();
      const dbPath = pathService.join(dir, "dedupe.db");
      yield* seedDatabase(dbPath, (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          const usage = [...protoNumber(1, 246), ...protoNumber(2, 80), ...protoText(11, "turn-1")];
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [
            0,
            new Uint8Array(protoBytes(9, usage)),
          ]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            new Uint8Array(
              protoBytes(1, [
                ...protoText(19, "Gemini 2.5 Pro"),
                ...protoBytes(4, [...usage, ...protoNumber(3, 30)]),
              ]),
            ),
          ]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0, cache);
      assert.deepStrictEqual(result.errors, []);
      const canonical = yield* Effect.promise(() => NodeFSP.realpath(dbPath));
      assert.strictEqual(cache.get(canonical)?.data?.candidates.length, 1);
      assert.strictEqual(records(result)[0]?.totals.uncachedInputTokens, 80);
      assert.strictEqual(records(result)[0]?.totals.outputTokens, 30);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "leaves mixed-modelId non-concrete key components unmerged so global tie-breaking stays exact",
    () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const dir = yield* tempDir;
        const cache = makeAntigravityUsageCache();
        const dbPath = pathService.join(dir, "mixed-non-concrete.db");
        yield* seedDatabase(dbPath, (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            // L: id 9001, q0 (unnamed), keys k1 + k2
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              0,
              new Uint8Array(
                protoBytes(9, [
                  ...protoNumber(1, 9001),
                  ...protoNumber(2, 10),
                  ...protoText(11, "k1"),
                  ...protoText(12, "k2"),
                ]),
              ),
            ]);
            // M: id 9002, q1 ("gemini-3-flash-agent"), key k2
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              1,
              new Uint8Array([
                ...protoBytes(24, [
                  ...protoNumber(1, 9002),
                  ...protoText(12, "gemini-3-flash-agent"),
                ]),
                ...protoBytes(9, [
                  ...protoNumber(1, 9002),
                  ...protoNumber(2, 20),
                  ...protoText(12, "k2"),
                ]),
              ]),
            ]);
            // H: id 9001, q1 ("gemini-3-flash-b"), key k1
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              2,
              new Uint8Array([
                ...protoBytes(24, [...protoNumber(1, 9001), ...protoText(12, "gemini-3-flash-b")]),
                ...protoBytes(9, [
                  ...protoNumber(1, 9001),
                  ...protoNumber(2, 30),
                  ...protoText(11, "k1"),
                ]),
              ]),
            ]);
          }),
        );
        const result = yield* readAntigravityUsage(dir, 0, cache);
        assert.deepStrictEqual(result.errors, []);
        const canonical = yield* Effect.promise(() => NodeFSP.realpath(dbPath));
        // Mixed-ID non-concrete component must not be pre-merged before global resolution.
        assert.strictEqual(cache.get(canonical)?.data?.candidates.length, 3);
        const read = records(result);
        assert.strictEqual(read.length, 1);
        assert.strictEqual(read[0]?.model, "gemini-3-flash-agent");
        assert.strictEqual(read[0]?.totals.uncachedInputTokens, 30);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "leaves components with conflicting top-quality models unmerged for exact tie-breaks",
    () =>
      Effect.gen(function* () {
        const pathService = yield* Path.Path;
        const dir = yield* tempDir;
        const cache = makeAntigravityUsageCache();
        const dbPath = pathService.join(dir, "conflicting-q4.db");
        yield* seedDatabase(dbPath, (db) =>
          Effect.gen(function* () {
            yield* createTables(db);
            // a0: q0, k1
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              0,
              new Uint8Array(protoBytes(9, [...protoNumber(2, 10), ...protoText(11, "k1")])),
            ]);
            // a1: q4 claude-sonnet-4, k2
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              1,
              new Uint8Array([
                ...protoBytes(24, protoText(12, "claude-sonnet-4")),
                ...protoBytes(9, [...protoNumber(2, 20), ...protoText(12, "k2")]),
              ]),
            ]);
            // a2: q4 gemini-2.5-pro, k1 (joins a0's owner-0 group before a3 bridges k1+k2)
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              2,
              new Uint8Array([
                ...protoBytes(24, protoText(12, "gemini-2.5-pro")),
                ...protoBytes(9, [...protoNumber(2, 30), ...protoText(11, "k1")]),
              ]),
            ]);
            // a3: q0, k1 + k2
            yield* db.run("INSERT INTO steps VALUES (?, ?)", [
              3,
              new Uint8Array(
                protoBytes(9, [
                  ...protoNumber(2, 40),
                  ...protoText(11, "k1"),
                  ...protoText(12, "k2"),
                ]),
              ),
            ]);
          }),
        );
        const result = yield* readAntigravityUsage(dir, 0, cache);
        assert.deepStrictEqual(result.errors, []);
        const canonical = yield* Effect.promise(() => NodeFSP.realpath(dbPath));
        assert.strictEqual(cache.get(canonical)?.data?.candidates.length, 4);
        const read = records(result);
        assert.strictEqual(read.length, 1);
        assert.strictEqual(read[0]?.model, "gemini-2.5-pro");
        assert.strictEqual(read[0]?.totals.uncachedInputTokens, 40);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads byte-bounded generation pages with large blobs and null step metadata", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const dir = yield* tempDir;
      const padding = protoBytes(99, new Array(300_000).fill(0x61));
      const largeGen = new Uint8Array(
        protoBytes(1, [
          ...protoBytes(4, [...protoNumber(2, 200), ...protoText(11, "large-1")]),
          ...protoText(19, "Gemini 3 Pro"),
          ...protoBytes(9, protoBytes(4, protoNumber(1, 1780000000))),
          ...padding,
        ]),
      );
      yield* seedDatabase(pathService.join(dir, "mixed-sizes.db"), (db) =>
        Effect.gen(function* () {
          yield* createTables(db);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            0,
            antigravityGeneration("g-0"),
          ]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [1, largeGen]);
          yield* db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            2,
            antigravityGeneration("g-2"),
          ]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [0, null]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [1, stepUsage("s-1")]);
          yield* db.run("INSERT INTO steps VALUES (?, ?)", [2, null]);
        }),
      );
      const result = yield* readAntigravityUsage(dir, 0);
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(
        records(result).map((r) => r.dedupeKey),
        [
          "antigravity:11:s-1",
          "antigravity:11:g-0",
          "antigravity:11:large-1",
          "antigravity:11:g-2",
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
