/**
 * Agents launch with this set to their thread, and every job they start inherits it, so a
 * process stays attributed after its launching shell exits or the agent settles.
 */
export const AGENT_THREAD_ENV = "T3CODE_THREAD_ID";

/**
 * Reads one variable from `/proc/<pid>/environ`, whose entries are NUL-separated. Only the named
 * variable is returned; the rest of the environment is never kept.
 */
export const parseProcEnvironValue = (raw: string, name: string): string | null => {
  const prefix = `${name}=`;
  const value = raw
    .split("\0")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  return value ? value : null;
};

/** Reads the parent pid from `/proc/<pid>/stat`, whose command field can hold spaces. */
export const parseProcStatParent = (raw: string): number | null => {
  const parent = Number(
    raw
      .slice(raw.lastIndexOf(")") + 1)
      .trim()
      .split(" ")[1],
  );
  return Number.isInteger(parent) ? parent : null;
};
