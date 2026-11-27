export interface AgentAttributionIdentity {
  readonly displayName?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly threadId?: string | undefined;
}

/**
 * Who can read the stamped text. A public repository (or one whose visibility is unknown) gets
 * only the neutral name and opaque UUIDs (PLAYBOOK §16 `agent-session-ids`); a private one keeps
 * the thread title and raw ids.
 */
export type AttributionAudience = "public" | "private";

export interface StampAgentProseOptions {
  readonly audience: AttributionAudience;
  readonly maxLength?: number | undefined;
}

const DEFAULT_DISPLAY_NAME = "MarsCode Agent";
const DEFAULT_EMAIL_LOCAL = "agent";
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_EMAIL_LOCAL_LENGTH = 64;
const GITHUB_MAX_BODY_LENGTH = 65_536;

// Keys are assembled so no literal trailer in this file reads as a titled stamp to the scanner.
const CO_AUTHOR_KEY = "Co-authored-by";
const SESSION_KEY = "Agent Session";
const THREAD_KEY = "Agent Thread";
const AGENT_MAIL_DOMAIN = "@agents.local";

const CO_AUTHOR_TRAILER_RE = new RegExp(
  `^${CO_AUTHOR_KEY}:\\s+[^\\n<>]+<[^\\s<>@]+${AGENT_MAIL_DOMAIN.replace(".", "\\.")}>\\s*$`,
  "i",
);
const AGENT_SESSION_TRAILER_RE = new RegExp(`^${SESSION_KEY}:\\s+\\S`);
const AGENT_THREAD_TRAILER_RE = new RegExp(`^${THREAD_KEY}:\\s+\\S`);
const TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9 -]*:\s+\S/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      out += " ";
    } else {
      out += value[i]!;
    }
  }
  return out;
}

function sanitizeDisplayName(raw: string | undefined): string {
  if (!raw) return DEFAULT_DISPLAY_NAME;
  const cleaned = stripControlChars(raw)
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .trim();
  return cleaned || DEFAULT_DISPLAY_NAME;
}

function sanitizeTrailerValue(raw: string | undefined): string {
  if (!raw) return "";
  return stripControlChars(raw).replace(/\s+/g, " ").trim();
}

function slugifyEmailLocal(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, MAX_EMAIL_LOCAL_LENGTH)
    .replace(/[._-]+$/g, "");
}

function deriveEmailLocal(displayName: string, fallbackId: string): string {
  return slugifyEmailLocal(displayName) || slugifyEmailLocal(fallbackId) || DEFAULT_EMAIL_LOCAL;
}

function sliceUtf16Safe(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function trailer(key: string, value: string): string {
  return `${key}: ${value}`;
}

/** The neutral stamp: only UUID ids survive, and the co-author is always the neutral name. */
function formatPublicAttribution(sessionId: string, threadId: string): string {
  const session = UUID_RE.test(sessionId) ? sessionId.toLowerCase() : "";
  const thread = UUID_RE.test(threadId) ? threadId.toLowerCase() : "";
  const mailbox = thread || session;
  if (!mailbox) return "";
  const lines = [
    trailer(CO_AUTHOR_KEY, `${DEFAULT_DISPLAY_NAME} <${mailbox}${AGENT_MAIL_DOMAIN}>`),
  ];
  if (session) lines.push(trailer(SESSION_KEY, session));
  if (thread) lines.push(trailer(THREAD_KEY, thread));
  return lines.join("\n");
}

/**
 * Formats a deterministic GitHub prose attribution trailer block for an agent caller.
 * Returns `""` when no id the audience may see is present.
 */
export function formatAgentAttribution(
  identity: AgentAttributionIdentity,
  audience: AttributionAudience,
): string {
  const sessionId = sanitizeTrailerValue(identity.sessionId);
  const threadId = sanitizeTrailerValue(identity.threadId);
  if (!sessionId && !threadId) return "";
  if (audience === "public") return formatPublicAttribution(sessionId, threadId);

  const displayName = sanitizeDisplayName(identity.displayName);
  const emailLocal = deriveEmailLocal(displayName, threadId || sessionId);
  const lines = [trailer(CO_AUTHOR_KEY, `${displayName} <${emailLocal}${AGENT_MAIL_DOMAIN}>`)];
  if (sessionId) lines.push(trailer(SESSION_KEY, sessionId));
  if (threadId) lines.push(trailer(THREAD_KEY, threadId));
  return lines.join("\n");
}

/**
 * Returns `true` when `body` ends with a valid trailing attribution trailer block holding an
 * agent co-author, session, or thread trailer.
 */
export function hasAgentAttribution(body: string): boolean {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") {
    end -= 1;
  }
  if (end === 0) return false;

  let start = end;
  while (start > 0 && lines[start - 1]!.trim() !== "") {
    start -= 1;
  }
  const trailingBlock = lines.slice(start, end);
  if (!trailingBlock.every((line) => TRAILER_LINE_RE.test(line))) {
    return false;
  }
  return trailingBlock.some(
    (line) =>
      CO_AUTHOR_TRAILER_RE.test(line) ||
      AGENT_SESSION_TRAILER_RE.test(line) ||
      AGENT_THREAD_TRAILER_RE.test(line),
  );
}

/**
 * Appends the agent attribution trailer block to GitHub prose idempotently while
 * respecting `maxLength` (default 65,536 characters) without dropping the stamp.
 */
export function stampAgentProse(
  body: string,
  identity: AgentAttributionIdentity,
  options: StampAgentProseOptions,
): string {
  const stamp = formatAgentAttribution(identity, options.audience);
  if (!stamp) return body;
  if (hasAgentAttribution(body)) return body;

  const maxLength = options.maxLength ?? GITHUB_MAX_BODY_LENGTH;
  if (maxLength <= 0) return "";
  if (stamp.length >= maxLength) {
    return sliceUtf16Safe(stamp, maxLength);
  }

  const trimmedBody = body.replace(/[\r\n]+$/, "");
  if (trimmedBody.trim().length === 0) {
    return stamp;
  }

  const separator = "\n\n";
  if (trimmedBody.length + separator.length + stamp.length <= maxLength) {
    return `${trimmedBody}${separator}${stamp}`;
  }

  const budget = maxLength - separator.length - stamp.length;
  if (budget <= 0) return stamp;

  const ellipsis = "...";
  if (budget <= ellipsis.length) {
    const prefix = sliceUtf16Safe(trimmedBody, budget).replace(/[\r\n]+$/, "");
    return prefix ? `${prefix}${separator}${stamp}` : stamp;
  }

  const prefix = sliceUtf16Safe(trimmedBody, budget - ellipsis.length).replace(/[\r\n]+$/, "");
  return prefix ? `${prefix}${ellipsis}${separator}${stamp}` : stamp;
}
