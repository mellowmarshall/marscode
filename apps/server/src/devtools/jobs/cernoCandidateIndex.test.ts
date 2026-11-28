import { describe, expect, it } from "@effect/vitest";

import {
  cernoMatchesBackgroundJob,
  indexCernoCandidates,
  type CernoJobMatchCandidate,
} from "./cernoJobMatcher.ts";

const identityRealpath = (p: string) => p;

function candidate(
  i: number,
  overrides: Partial<CernoJobMatchCandidate> = {},
): CernoJobMatchCandidate {
  return {
    id: `cerno:${1000 + i}:${5000 + i}`,
    threadId: `thread-${i}`,
    cwd: `/work/repo-${i}`,
    state: "running",
    command: `cerno watch --monitor --log run-${i}.log -- vp test run suite-${i}`,
    logPath: `run-${i}.log`,
    pidStats: { pid: 1000 + i, alive: true },
    ...overrides,
  };
}

/** Wraps a candidate so every read of `command` is counted. */
function counted(c: CernoJobMatchCandidate, reads: { n: number }): CernoJobMatchCandidate {
  return {
    ...c,
    get command() {
      reads.n += 1;
      return c.command;
    },
  };
}

describe("indexCernoCandidates", () => {
  it("finds the same first live candidate as a full scan of the predicate", () => {
    const candidates = [
      candidate(0),
      candidate(1, { state: "done" }),
      candidate(2, { pidStats: { pid: 1002, alive: false } }),
      candidate(3, { logPath: "/abs/shared.log" }),
      candidate(4, { logPath: "/abs/shared.log" }),
      candidate(5, { cwd: "/work/repo-6/packages/app", logPath: "out.log", threadId: undefined }),
      candidate(6, { logPath: undefined, command: "vp run build --filter web" }),
      candidate(7, { cwd: "/", logPath: "root.log", threadId: undefined }),
    ];
    const bgs = [
      { threadId: "thread-0", worktreePath: "/work/repo-0", logPath: "/work/repo-0/run-0.log" },
      { threadId: "thread-1", worktreePath: "/work/repo-1", logPath: "/work/repo-1/run-1.log" },
      { threadId: "thread-2", worktreePath: "/work/repo-2", logPath: "/work/repo-2/run-2.log" },
      { threadId: "thread-4", logPath: "/abs/shared.log" },
      { threadId: "thread-3", logPath: "/abs/shared.log" },
      { worktreePath: "/work/repo-6", command: "cerno watch --log out.log -- vp build" },
      { worktreePath: "/work", command: "cerno watch --log out.log -- vp build" },
      { threadId: "thread-6", command: "cd /work/repo-6 && vp run build --filter web" },
      { threadId: "thread-6", command: "vp run lint" },
      { worktreePath: "/", command: "cerno watch --log root.log -- vp build" },
      { threadId: "thread-9", worktreePath: "/elsewhere", logPath: "/elsewhere/x.log" },
    ];
    const index = indexCernoCandidates(candidates, identityRealpath);
    for (const bg of bgs) {
      const scanned = candidates.find(
        (c) => c.state === "running" && c.pidStats?.alive && cernoMatchesBackgroundJob(c, bg),
      );
      expect(index.find(bg)?.id, JSON.stringify(bg)).toBe(scanned?.id);
    }
    expect(index.find(bgs[0]!)?.id).toBe("cerno:1000:5000");
    expect(index.find(bgs[3]!)?.id).toBe("cerno:1004:5004");
    expect(index.find(bgs[4]!)?.id).toBe("cerno:1003:5003");
    expect(index.find(bgs[5]!)?.id).toBe("cerno:1005:5005");
    expect(index.find(bgs[7]!)?.id).toBe("cerno:1006:5006");
  });

  it("evaluates only indexed hits per background job, not every candidate", () => {
    const reads = { n: 0 };
    const total = 200;
    const projectName = (i: number) => `suite-${String(i).padStart(3, "0")}`;
    // One thread and one shared command prefix, so a scan would compare every command.
    const candidates = Array.from({ length: total }, (_, i) =>
      counted(
        candidate(i, {
          threadId: "thread-shared",
          command: `cerno watch --monitor --log run-${i}.log -- vp test run --project ${projectName(i)}`,
        }),
        reads,
      ),
    );
    const index = indexCernoCandidates(candidates, identityRealpath);
    expect(reads.n).toBe(total);

    const bgCount = 50;
    for (let i = 0; i < bgCount; i += 1) {
      const bg = { threadId: "thread-shared", command: `vp test run --project ${projectName(i)}` };
      expect(index.find(bg)?.id).toBe(`cerno:${1000 + i}:${5000 + i}`);
    }
    // One command read per matched candidate; a scan would read up to bgCount * total.
    expect(reads.n).toBe(total + bgCount);
  });

  it("agrees with the predicate across mixed threads, prefixes, cwds and log paths", () => {
    const words = ["vp", "test", "run", "build", "--filter", "web", "a", "longer-argument-text"];
    const pick = (seed: number, n: number) =>
      Array.from({ length: n }, (_, k) => words[(seed * 7 + k * 3) % words.length]).join(" ");
    const threads = ["t-a", "t-b", undefined];
    const cwds = ["/w", "/w/pkg", "/w/pkg/sub", "/other", undefined];
    const logs = ["out.log", "/abs/out.log", "/w/out.log", undefined];
    const candidates = Array.from({ length: 60 }, (_, i) =>
      candidate(i, {
        threadId: threads[i % 3],
        cwd: cwds[i % 5],
        logPath: logs[i % 4],
        command: pick(i, 2 + (i % 12)),
        state: i % 11 === 0 ? "done" : "running",
      }),
    );
    const index = indexCernoCandidates(candidates, identityRealpath);
    let matched = 0;
    for (let j = 0; j < 120; j += 1) {
      const bg = {
        threadId: threads[j % 3],
        worktreePath: cwds[(j + 1) % 5],
        command: j % 4 === 0 ? `cerno watch --log out.log -- ${pick(j, 3)}` : pick(j, 1 + (j % 14)),
        logPath: j % 5 === 0 ? logs[j % 4] : undefined,
      };
      const scanned = candidates.find(
        (c) => c.state === "running" && c.pidStats?.alive && cernoMatchesBackgroundJob(c, bg),
      );
      if (scanned) matched += 1;
      expect(index.find(bg)?.id, JSON.stringify(bg)).toBe(scanned?.id);
      // Pairing reads every match from the index, so it must equal a full scan too.
      const allScanned = candidates.filter(
        (c) => c.state === "running" && c.pidStats?.alive && cernoMatchesBackgroundJob(c, bg),
      );
      expect(
        index.matches(bg).map((c) => c.id),
        JSON.stringify(bg),
      ).toEqual(allScanned.map((c) => c.id));
    }
    expect(matched).toBeGreaterThan(10);
  });

  it("resolves each distinct path once for the life of the index", () => {
    const resolved: string[] = [];
    const realpath = (p: string) => {
      resolved.push(p);
      return p;
    };
    const candidates = Array.from({ length: 20 }, (_, i) => candidate(i));
    const index = indexCernoCandidates(candidates, realpath);
    const bg = { threadId: "thread-3", logPath: "/work/repo-3/run-3.log" };
    for (let i = 0; i < 10; i += 1) expect(index.find(bg)?.id).toBe("cerno:1003:5003");
    expect(resolved.length).toBe(new Set(resolved).size);
  });
});
