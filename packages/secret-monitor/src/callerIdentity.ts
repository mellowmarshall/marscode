import {
  AGENT_THREAD_ENV,
  parseProcEnvironValue,
  parseProcStatParent,
} from "@t3tools/shared/procIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/** Ancestors examined for a thread before the caller is treated as outside T3. */
const MAX_ANCESTRY_DEPTH = 64;
const MAX_THREAD_ID_LENGTH = 128;

const FRIENDLY_NAMES: Readonly<Record<string, string>> = {
  chrome: "Google Chrome",
  chromium: "Chromium",
  "google-chrome": "Google Chrome",
  firefox: "Firefox",
  slack: "Slack",
  code: "VS Code",
  codex: "Codex",
  claude: "Claude Code",
  zcode: "zcode",
  "secret-tool": "secret-tool (direct keyring read)",
};

export const UNIDENTIFIED_CALLER = "an unidentified process";

/** Who made a Secret Service call, in terms a person recognises. */
export const CallerIdentity = Schema.Struct({
  pid: Schema.NullOr(Schema.Number),
  comm: Schema.NullOr(Schema.String),
  /** The T3 thread the caller runs under, from `T3CODE_THREAD_ID` on it or an ancestor. */
  threadId: Schema.NullOr(Schema.String),
  /** The pid whose environment named the thread. */
  threadPid: Schema.NullOr(Schema.Number),
  label: Schema.String,
});
export type CallerIdentity = typeof CallerIdentity.Type;

export const unidentifiedCaller = (pid: number | null): CallerIdentity => ({
  pid,
  comm: null,
  threadId: null,
  threadPid: null,
  label: UNIDENTIFIED_CALLER,
});

export const friendlyProcessName = (comm: string): string => {
  const known = FRIENDLY_NAMES[comm];
  if (known !== undefined) return known;
  return comm ? comm.charAt(0).toUpperCase() + comm.slice(1) : UNIDENTIFIED_CALLER;
};

// C0, DEL and C1 controls: escape sequences a hostile process name or environment could plant
// in the log and the terminal that shows it.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

export const stripControlCharacters = (value: string): string =>
  value.replace(CONTROL_CHARACTERS, "");

const sanitizeThreadId = (value: string): string | null => {
  const cleaned = stripControlCharacters(value).slice(0, MAX_THREAD_ID_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
};

/**
 * Resolves a caller pid through `/proc`. The thread comes from the nearest process, the caller
 * included, whose environment holds `T3CODE_THREAD_ID`; only that variable is read.
 */
export const resolveCallerIdentity = Effect.fn("SecretMonitor.resolveCallerIdentity")(function* (
  pid: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const read = (path: string) =>
    fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => null));

  const rawComm = yield* read(`/proc/${pid}/comm`);
  const comm = rawComm === null ? null : stripControlCharacters(rawComm).trim();
  if (comm === null) return unidentifiedCaller(pid);

  const seen = new Set<number>();
  let current: number | null = pid;
  while (current !== null && current > 1 && !seen.has(current) && seen.size < MAX_ANCESTRY_DEPTH) {
    seen.add(current);
    const environ = yield* read(`/proc/${current}/environ`);
    const value = environ === null ? null : parseProcEnvironValue(environ, AGENT_THREAD_ENV);
    const threadId = value === null ? null : sanitizeThreadId(value);
    if (threadId !== null) {
      const identity: CallerIdentity = {
        pid,
        comm,
        threadId,
        threadPid: current,
        label: `T3 thread ${threadId}`,
      };
      return identity;
    }
    const stat: string | null = yield* read(`/proc/${current}/stat`);
    current = stat === null ? null : parseProcStatParent(stat);
  }
  const identity: CallerIdentity = {
    pid,
    comm,
    threadId: null,
    threadPid: null,
    label: friendlyProcessName(comm),
  };
  return identity;
});
