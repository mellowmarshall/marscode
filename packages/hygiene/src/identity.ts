/** PLAYBOOK §16.2 `commit-identity`: only platform noreply addresses author, commit, or co-author. */

const AUTHOR_NOREPLY = /^[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/;
const TRAILER_NOREPLY =
  /^(?:noreply@[A-Za-z0-9.-]+|[A-Za-z0-9+._-]+@users\.noreply\.github\.com)$/i;
const TRAILER_EMAIL = /^\s*[A-Za-z][A-Za-z0-9-]*:\s(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");
const THREAD_LINK_RE = new RegExp(`^t3-thread://${UUID}(?:/${UUID})*$`, "i");

/** The only co-author name an `agents.local` trailer may carry; any other name is a thread title. */
export const NEUTRAL_AGENT_NAME = "MarsCode Agent";

/** An opaque agent attribution: the neutral name with a bare UUID mailbox. */
export function isNeutralAgentTrailer(name: string, email: string): boolean {
  const at = email.lastIndexOf("@agents.local");
  return name === NEUTRAL_AGENT_NAME && at > 0 && UUID_RE.test(email.slice(0, at));
}

/** An `Agent Session:` / `Agent Thread:` value that is only a UUID or a UUID-only thread link. */
export function isOpaqueAgentId(value: string): boolean {
  return UUID_RE.test(value) || THREAD_LINK_RE.test(value);
}

/** Whether an author or committer email is a GitHub id+login noreply address. */
export function checkIdentity(email: string): boolean {
  return AUTHOR_NOREPLY.test(email.trim());
}

export function checkTrailerEmail(email: string): boolean {
  return TRAILER_NOREPLY.test(email.trim());
}

/** `Key: Name <email>` trailer lines of a commit message, with 1-based line numbers. */
export function trailerEmails(
  message: string,
): ReadonlyArray<{ line: number; name: string; email: string }> {
  const out: Array<{ line: number; name: string; email: string }> = [];
  const lines = message.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = TRAILER_EMAIL.exec(lines[i] ?? "");
    if (match?.[2]) out.push({ line: i + 1, name: match[1] ?? "", email: match[2] });
  }
  return out;
}

/** The email of a `git var GIT_AUTHOR_IDENT`-style `Name <email> epoch tz` line. */
export function identEmail(ident: string): string | null {
  return /<([^<>]*)>/.exec(ident)?.[1] ?? null;
}
