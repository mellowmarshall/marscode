/**
 * Allow-list for native fleet API paths served under `/api/devtools/devdeck/*`.
 * Rejects traversal segments, control characters, and unknown query keys before dispatch.
 */
const SAFE_SEG = "[A-Za-z0-9._-]+";
const SAFE_ENCODED_SERVER_ID = `${SAFE_SEG}(?:%2[Ff]${SAFE_SEG})?`;
const SAFE_SESSION_ID = "[A-Za-z0-9._:@%-]{1,128}";

const ALLOWED_GET_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/snapshot$/,
  /^\/api\/events$/,
  /^\/api\/servers$/,
  /^\/api\/nodes$/,
  new RegExp(`^/api/actions/${SAFE_SEG}$`),
];

const SESSION_CLOSE_PATH_RE = new RegExp(`^/api/sessions/${SAFE_SESSION_ID}/close$`);

const ALLOWED_POST_PATHS: ReadonlyArray<RegExp> = [
  new RegExp(`^/api/servers/${SAFE_ENCODED_SERVER_ID}/(start|stop)$`),
  new RegExp(`^/api/servers/${SAFE_SEG}/${SAFE_SEG}/(start|stop)$`),
  /^\/api\/hosts\/check$/,
  new RegExp(`^/api/hosts/${SAFE_SEG}/(provision|ci)$`),
  SESSION_CLOSE_PATH_RE,
  new RegExp(`^/api/nodes/${SAFE_SEG}/kick$`),
];

const ALLOWED_QUERY_KEYS = new Map<string, RegExp>([
  ["panels", /^[a-z0-9,_-]{1,128}$/],
  ["passive", /^[01]$/],
  ["delta", /^[01]$/],
  ["node", /^[A-Za-z0-9._-]{1,64}$/],
]);

function hasUnsafePathSegments(pathname: string): boolean {
  if (pathname.includes("\\") || /[\u0000-\u001f\u007f]/.test(pathname)) return true;
  const segments = pathname.split("/");
  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (!seg || seg === "." || seg === "..") return true;
    try {
      const decoded = decodeURIComponent(seg);
      if (decoded === "." || decoded === ".." || decoded.includes("\\")) return true;
      for (const part of decoded.split("/")) {
        if (!part || part === "." || part === "..") return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function isAllowedFleetPath(method: string, apiPath: string): boolean {
  const qIdx = apiPath.indexOf("?");
  const cleanPath = qIdx === -1 ? apiPath : apiPath.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? "" : apiPath.slice(qIdx + 1);
  if (hasUnsafePathSegments(cleanPath)) return false;

  if (rawQuery) {
    const isAllowedGetQuery =
      method === "GET" && (cleanPath === "/api/events" || cleanPath === "/api/snapshot");
    const isAllowedSessionCloseQuery = method === "POST" && SESSION_CLOSE_PATH_RE.test(cleanPath);
    if (!isAllowedGetQuery && !isAllowedSessionCloseQuery) {
      return false;
    }
    const params = new URLSearchParams(rawQuery);
    for (const [key, value] of params.entries()) {
      if (isAllowedSessionCloseQuery && key !== "node") return false;
      const validator = ALLOWED_QUERY_KEYS.get(key);
      if (!validator || !validator.test(value)) return false;
    }
  }

  if (method === "GET") {
    return ALLOWED_GET_PATHS.some((re) => re.test(cleanPath));
  }
  if (method === "POST") {
    return ALLOWED_POST_PATHS.some((re) => re.test(cleanPath));
  }
  return false;
}
