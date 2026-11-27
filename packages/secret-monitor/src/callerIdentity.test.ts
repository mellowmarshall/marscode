import { describe, expect, it } from "@effect/vitest";
import { AGENT_THREAD_ENV } from "@t3tools/shared/procIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  friendlyProcessName,
  resolveCallerIdentity,
  stripControlCharacters,
  UNIDENTIFIED_CALLER,
} from "./callerIdentity.ts";

const procFileSystem = (files: Readonly<Record<string, string>>) => {
  const missing = FileSystem.makeNoop({});
  const reads: string[] = [];
  const layer = FileSystem.layerNoop({
    readFileString: (path) => {
      reads.push(path);
      const content = files[path];
      return content === undefined ? missing.readFileString(path) : Effect.succeed(content);
    },
  });
  return { layer, reads };
};

describe("resolveCallerIdentity", () => {
  it.effect("names the T3 thread from the nearest ancestor carrying it", () => {
    const proc = procFileSystem({
      "/proc/300/comm": "secret-tool\n",
      "/proc/300/environ": "PATH=/usr/bin\0",
      "/proc/300/stat": "300 (secret-tool) S 200 300 300 0",
      "/proc/200/environ": `HOME=/home/dev\0${AGENT_THREAD_ENV}=thread-abc\0SECRET=never-read\0`,
      "/proc/200/stat": "200 (bash) S 100 200 200 0",
    });
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(300);
      expect(identity).toEqual({
        pid: 300,
        comm: "secret-tool",
        threadId: "thread-abc",
        threadPid: 200,
        label: "T3 thread thread-abc",
      });
      expect(proc.reads).not.toContain("/proc/100/environ");
    }).pipe(Effect.provide(proc.layer));
  });

  it.effect("parses a parent from a stat whose command holds spaces and parentheses", () => {
    const proc = procFileSystem({
      "/proc/300/comm": "node",
      "/proc/300/environ": "",
      "/proc/300/stat": "300 (agy (acp) x) S 250 300 300 0",
      "/proc/250/environ": `${AGENT_THREAD_ENV}=thread-xyz\0`,
    });
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(300);
      expect(identity.threadId).toBe("thread-xyz");
      expect(identity.threadPid).toBe(250);
    }).pipe(Effect.provide(proc.layer));
  });

  it.effect("falls back to a friendly process name outside T3", () => {
    const proc = procFileSystem({
      "/proc/400/comm": "chrome\n",
      "/proc/400/environ": "PATH=/usr/bin\0",
      "/proc/400/stat": "400 (chrome) S 1 400 400 0",
    });
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(400);
      expect(identity).toEqual({
        pid: 400,
        comm: "chrome",
        threadId: null,
        threadPid: null,
        label: "Google Chrome",
      });
    }).pipe(Effect.provide(proc.layer));
  });

  it.effect("reports an exited process as unidentified", () => {
    const proc = procFileSystem({});
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(500);
      expect(identity).toEqual({
        pid: 500,
        comm: null,
        threadId: null,
        threadPid: null,
        label: UNIDENTIFIED_CALLER,
      });
    }).pipe(Effect.provide(proc.layer));
  });

  it.effect("stops on a parent cycle", () => {
    const proc = procFileSystem({
      "/proc/600/comm": "loop",
      "/proc/600/stat": "600 (loop) S 601 600 600 0",
      "/proc/601/stat": "601 (loop) S 600 601 601 0",
    });
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(600);
      expect(identity.threadId).toBeNull();
      expect(proc.reads.filter((path) => path === "/proc/600/stat")).toHaveLength(1);
    }).pipe(Effect.provide(proc.layer));
  });

  it.effect("strips C0 and C1 controls from the process name and thread id", () => {
    const proc = procFileSystem({
      "/proc/800/comm": "evil\u001b]0;pwned\u0007\u009b31m\n",
      "/proc/800/environ": `${AGENT_THREAD_ENV}=thread\u0085-\u009dnext\u007f\0`,
    });
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(800);
      expect(identity.comm).toBe("evil]0;pwned31m");
      expect(identity.threadId).toBe("thread-next");
      expect(identity.label).toBe("T3 thread thread-next");
    }).pipe(Effect.provide(proc.layer));
  });

  it.effect("labels a caller outside T3 without control characters", () => {
    const proc = procFileSystem({
      "/proc/801/comm": "\u009bmyapp\u001b\n",
      "/proc/801/environ": "",
      "/proc/801/stat": "801 (myapp) S 1 801 801 0",
    });
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(801);
      expect(identity.label).toBe("Myapp");
    }).pipe(Effect.provide(proc.layer));
  });

  it.effect("strips control bytes from a thread id", () => {
    const proc = procFileSystem({
      "/proc/700/comm": "sh",
      "/proc/700/environ": `${AGENT_THREAD_ENV}=thread\u001b[31m-red\0`,
    });
    return Effect.gen(function* () {
      const identity = yield* resolveCallerIdentity(700);
      expect(identity.threadId).toBe("thread[31m-red");
    }).pipe(Effect.provide(proc.layer));
  });
});

describe("stripControlCharacters", () => {
  it("removes C0, DEL and C1 controls and keeps printable text", () => {
    expect(stripControlCharacters("a\u0000b\u001fc\u007fd\u0080e\u009ff\u00a0g")).toBe(
      "abcdef\u00a0g",
    );
  });
});

describe("friendlyProcessName", () => {
  it("maps known commands and capitalises the rest", () => {
    expect(friendlyProcessName("secret-tool")).toBe("secret-tool (direct keyring read)");
    expect(friendlyProcessName("claude")).toBe("Claude Code");
    expect(friendlyProcessName("myapp")).toBe("Myapp");
    expect(friendlyProcessName("")).toBe(UNIDENTIFIED_CALLER);
  });
});
