// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Direct Unix-socket HTTP/SSE proxy to local devdeck daemon.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

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
  /^\/api\/usage\/refresh$/,
  SESSION_CLOSE_PATH_RE,
  new RegExp(`^/api/nodes/${SAFE_SEG}/kick$`),
];

const ALLOWED_QUERY_KEYS = new Map<string, RegExp>([
  ["panels", /^[a-z0-9,_-]{1,128}$/],
  ["passive", /^[01]$/],
  ["delta", /^[01]$/],
  ["node", /^[A-Za-z0-9._-]{1,64}$/],
]);

const DEFAULT_DEVDECK_PORT = 3210;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SSE_PENDING_BYTES = 256 * 1024;
const SSE_STALL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PASSIVE_PROBE_TIMEOUT_MS = 500;
const SOCKET_CACHE_TTL_MS = 5_000;

export interface DevdeckTarget {
  readonly kind: "unix" | "tcp";
  readonly socketPath?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

export interface DevdeckHealthProbe {
  readonly reachable: boolean;
  readonly passiveSupported: boolean;
  readonly target: DevdeckTarget;
}

let cachedSocket: { readonly value: string | null; readonly expiresAt: number } | null = null;
let cachedHealthProbe: {
  readonly targetKey: string;
  readonly health: DevdeckHealthProbe;
  readonly expiresAt: number;
} | null = null;
let endpointOverrideRaw = "";

export function invalidateDevdeckProbeCache(): void {
  cachedSocket = null;
  cachedHealthProbe = null;
}

export function setDevdeckEndpointOverride(raw: string): void {
  const next = raw.trim();
  if (next === endpointOverrideRaw) return;
  endpointOverrideRaw = next;
  invalidateDevdeckProbeCache();
}

export function hasDevdeckEndpointOverride(): boolean {
  return endpointOverrideRaw.length > 0;
}

function targetCacheKey(target: DevdeckTarget): string {
  return target.kind === "unix"
    ? `unix:${target.socketPath ?? ""}`
    : `tcp:${target.host ?? "127.0.0.1"}:${target.port ?? DEFAULT_DEVDECK_PORT}`;
}

function resolveTcpDevdeckTarget(): DevdeckTarget {
  const rawAddr = process.env.DEVDECK_ADDR?.trim() || `127.0.0.1:${DEFAULT_DEVDECK_PORT}`;
  const lastColon = rawAddr.lastIndexOf(":");
  const parsedPort = lastColon > 0 ? Number(rawAddr.slice(lastColon + 1)) : DEFAULT_DEVDECK_PORT;
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_DEVDECK_PORT;
  return { kind: "tcp", host: "127.0.0.1", port };
}

function probeSingleTarget(target: DevdeckTarget): Promise<DevdeckHealthProbe> {
  return new Promise<DevdeckHealthProbe>((resolve) => {
    let settled = false;
    const done = (val: DevdeckHealthProbe) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const options: NodeHttp.RequestOptions =
      target.kind === "unix"
        ? { socketPath: target.socketPath, path: "/api/snapshot", method: "HEAD" }
        : {
            hostname: target.host ?? "127.0.0.1",
            port: target.port ?? DEFAULT_DEVDECK_PORT,
            path: "/api/snapshot",
            method: "HEAD",
          };
    const req = NodeHttp.request(options, (res) => {
      res.resume();
      const status = res.statusCode ?? 500;
      done({
        reachable: status >= 200 && status < 400,
        passiveSupported: res.headers["x-devdeck-passive"] === "1",
        target,
      });
    });
    req.setTimeout(PASSIVE_PROBE_TIMEOUT_MS, () => {
      req.destroy();
      done({ reachable: false, passiveSupported: false, target });
    });
    req.on("error", () => done({ reachable: false, passiveSupported: false, target }));
    req.end();
  });
}

/**
 * Lightweight cached HEAD probe against Unix socket or TCP `127.0.0.1:3210` DevDeck daemon.
 * If a stale Unix socket file exists after an unclean exit, automatically falls back to TCP.
 */
export async function probeDevdeckHealth(
  targetOverride?: DevdeckTarget,
): Promise<DevdeckHealthProbe> {
  const initialTarget = targetOverride ?? resolveDevdeckTarget();
  const key = targetOverride ? `override:${targetCacheKey(targetOverride)}` : "auto";
  const now = Date.now();
  if (
    cachedHealthProbe &&
    cachedHealthProbe.targetKey === key &&
    cachedHealthProbe.expiresAt > now
  ) {
    return cachedHealthProbe.health;
  }
  let health = await probeSingleTarget(initialTarget);
  if (!health.reachable && !targetOverride && initialTarget.kind === "unix") {
    const tcpFallback = resolveTcpDevdeckTarget();
    const tcpHealth = await probeSingleTarget(tcpFallback);
    if (tcpHealth.reachable) {
      health = tcpHealth;
    }
  }
  cachedHealthProbe = { targetKey: key, health, expiresAt: now + SOCKET_CACHE_TTL_MS };
  return health;
}

function resolveLiveDevdeckTarget(targetOverride?: DevdeckTarget): DevdeckTarget {
  if (targetOverride) return targetOverride;
  const now = Date.now();
  if (
    cachedHealthProbe &&
    cachedHealthProbe.targetKey === "auto" &&
    cachedHealthProbe.expiresAt > now &&
    cachedHealthProbe.health.reachable
  ) {
    return cachedHealthProbe.health.target;
  }
  return resolveDevdeckTarget();
}

function resolveDevdeckSocketPath(): string | null {
  const now = Date.now();
  if (cachedSocket && cachedSocket.expiresAt > now) {
    return cachedSocket.value;
  }
  const explicit = process.env.DEVDECK_UNIX_SOCKET?.trim();
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg) candidates.push(NodePath.join(xdg, "devdeck.sock"));

  let found: string | null = null;
  for (const sock of candidates) {
    try {
      const st = NodeFS.lstatSync(sock);
      if (st.isSocket()) {
        found = sock;
        break;
      }
    } catch {
      // try next
    }
  }
  cachedSocket = { value: found, expiresAt: now + SOCKET_CACHE_TTL_MS };
  return found;
}

function resolveDevdeckTarget(): DevdeckTarget {
  if (endpointOverrideRaw) {
    if (endpointOverrideRaw.startsWith("/")) {
      return { kind: "unix", socketPath: endpointOverrideRaw };
    }
    const lastColon = endpointOverrideRaw.lastIndexOf(":");
    const parsedPort =
      lastColon > 0 ? Number(endpointOverrideRaw.slice(lastColon + 1)) : DEFAULT_DEVDECK_PORT;
    if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
      return { kind: "tcp", host: "127.0.0.1", port: parsedPort };
    }
  }
  const socketPath = resolveDevdeckSocketPath();
  if (socketPath) {
    return { kind: "unix", socketPath };
  }
  const rawAddr = process.env.DEVDECK_ADDR?.trim() || `127.0.0.1:${DEFAULT_DEVDECK_PORT}`;
  const lastColon = rawAddr.lastIndexOf(":");
  const parsedPort = lastColon > 0 ? Number(rawAddr.slice(lastColon + 1)) : DEFAULT_DEVDECK_PORT;
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_DEVDECK_PORT;
  return { kind: "tcp", host: "127.0.0.1", port };
}

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

export function isAllowedDevdeckPath(method: string, apiPath: string): boolean {
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

const PRE_CONNECT_ERR_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EACCES", "EPERM"]);

function proxyDevdeckRequestOnce(input: {
  readonly apiPath: string;
  readonly method: "GET" | "POST";
  readonly body?: string | undefined;
  readonly target: DevdeckTarget;
  readonly signal?: AbortSignal | undefined;
}): Promise<{
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly connectFailed?: boolean;
}> {
  const target = input.target;
  const baseHeaders: Record<string, string | number> = {
    accept: "application/json",
    ...(input.body
      ? { "content-type": "application/json", "content-length": Buffer.byteLength(input.body) }
      : {}),
  };
  const options: NodeHttp.RequestOptions =
    target.kind === "unix"
      ? {
          socketPath: target.socketPath,
          path: input.apiPath,
          method: input.method,
          headers: baseHeaders,
          timeout: REQUEST_TIMEOUT_MS,
        }
      : {
          hostname: target.host ?? "127.0.0.1",
          port: target.port ?? DEFAULT_DEVDECK_PORT,
          path: input.apiPath,
          method: input.method,
          headers: baseHeaders,
          timeout: REQUEST_TIMEOUT_MS,
        };

  return new Promise((resolve) => {
    let settled = false;
    let oversized = false;
    let connected = false;
    const finish = (result: {
      readonly status: number;
      readonly contentType: string;
      readonly body: string;
      readonly connectFailed?: boolean;
    }) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const req = NodeHttp.request(options, (res) => {
      connected = true;
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          oversized = true;
          res.destroy(new Error("devdeck response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (oversized) {
          finish({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ available: false, error: "devdeck response too large" }),
          });
          return;
        }
        finish({
          status: res.statusCode ?? 200,
          contentType: "application/json",
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("close", () => {
        if (oversized) {
          finish({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ available: false, error: "devdeck response too large" }),
          });
        } else if (!settled) {
          finish({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ available: false, error: "devdeck connection closed early" }),
          });
        }
      });
      res.on("error", (err) => {
        finish({
          status: oversized ? 502 : 503,
          contentType: "application/json",
          body: JSON.stringify({ available: false, error: err.message }),
        });
      });
    });

    const onAbort = () => {
      req.destroy(new Error("request aborted"));
    };
    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
        finish({
          status: 499,
          contentType: "application/json",
          body: JSON.stringify({ available: false, error: "request aborted" }),
        });
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("socket", (sock) => {
      if (!sock.connecting) {
        connected = true;
      } else {
        sock.once("connect", () => {
          connected = true;
        });
      }
    });
    req.on("timeout", () => {
      req.destroy(new Error("devdeck request timed out"));
    });
    req.on("error", (err) => {
      if (!oversized) {
        cachedSocket = null;
        cachedHealthProbe = null;
      }
      const code = (err as NodeJS.ErrnoException).code;
      const connectFailed =
        !oversized && !connected && typeof code === "string" && PRE_CONNECT_ERR_CODES.has(code);
      finish({
        status: oversized ? 502 : 503,
        contentType: "application/json",
        body: JSON.stringify({ available: false, error: err.message }),
        ...(connectFailed ? { connectFailed: true } : {}),
      });
    });
    if (input.body) {
      req.write(input.body);
    }
    req.end();
  });
}

export async function proxyDevdeckRequest(input: {
  readonly apiPath: string;
  readonly method: "GET" | "POST";
  readonly body?: string | undefined;
  readonly target?: DevdeckTarget | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<{ readonly status: number; readonly contentType: string; readonly body: string }> {
  const target = resolveLiveDevdeckTarget(input.target);
  const first = await proxyDevdeckRequestOnce({ ...input, target });
  // For POST mutations, fall back to TCP ONLY when the Unix socket never connected (0 bytes sent)
  // so an interrupted response after dispatch can never replay a mutation.
  const canFallback =
    first.status === 503 &&
    !input.target &&
    target.kind === "unix" &&
    !input.signal?.aborted &&
    (input.method === "GET" || first.connectFailed === true);
  if (canFallback) {
    const tcpFallback = resolveTcpDevdeckTarget();
    const second = await proxyDevdeckRequestOnce({ ...input, target: tcpFallback });
    if (second.status !== 503) {
      return { status: second.status, contentType: second.contentType, body: second.body };
    }
  }
  return { status: first.status, contentType: first.contentType, body: first.body };
}

export function createDevdeckEventStream(
  signal: AbortSignal,
  apiPath = "/api/events",
  targetOverride?: DevdeckTarget,
): ReadableStream<Uint8Array> {
  const initialTarget = resolveLiveDevdeckTarget(targetOverride);
  const encoder = new TextEncoder();
  let activeReq: NodeHttp.ClientRequest | null = null;
  let activeRes: NodeHttp.IncomingMessage | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  let pendingBytes = 0;
  const pendingChunks: Uint8Array[] = [];
  let streamClosed = false;

  const clearStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const detachAbort = () => {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const safeClose = () => {
          if (streamClosed) return;
          streamClosed = true;
          clearStallTimer();
          detachAbort();
          pendingChunks.length = 0;
          pendingBytes = 0;
          activeRes = null;
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        const flushOrPause = () => {
          if (streamClosed) return;
          while (pendingChunks.length > 0 && (controller.desiredSize ?? 0) > 0) {
            const next = pendingChunks.shift()!;
            pendingBytes -= next.byteLength;
            try {
              controller.enqueue(next);
            } catch {
              activeReq?.destroy();
              safeClose();
              return;
            }
          }
          if (pendingChunks.length === 0) {
            clearStallTimer();
            if (activeRes?.isPaused()) {
              activeRes.resume();
            }
          } else if (activeRes && !activeRes.isPaused()) {
            activeRes.pause();
            if (!stallTimer) {
              stallTimer = setTimeout(() => {
                activeReq?.destroy();
                safeClose();
              }, SSE_STALL_TIMEOUT_MS);
              stallTimer.unref();
            }
          }
        };

        const pushBytes = (bytes: Uint8Array) => {
          if (streamClosed) return;
          if (pendingBytes + bytes.byteLength > MAX_SSE_PENDING_BYTES) {
            activeReq?.destroy();
            safeClose();
            return;
          }
          pendingChunks.push(bytes);
          pendingBytes += bytes.byteLength;
          flushOrPause();
        };

        const openUpstream = (target: DevdeckTarget, allowTcpFallback: boolean) => {
          if (streamClosed) return;
          const options: NodeHttp.RequestOptions =
            target.kind === "unix"
              ? {
                  socketPath: target.socketPath,
                  path: apiPath,
                  method: "GET",
                  headers: { accept: "text/event-stream" },
                }
              : {
                  hostname: target.host ?? "127.0.0.1",
                  port: target.port ?? DEFAULT_DEVDECK_PORT,
                  path: apiPath,
                  method: "GET",
                  headers: { accept: "text/event-stream" },
                };

          const req = NodeHttp.request(options, (res) => {
            if (streamClosed) {
              res.resume();
              return;
            }
            activeRes = res;
            if ((res.statusCode ?? 500) >= 400) {
              res.resume();
              pushBytes(
                encoder.encode(
                  `event: unavailable\ndata: ${JSON.stringify({ status: res.statusCode ?? 503 })}\n\n`,
                ),
              );
              safeClose();
              return;
            }
            res.on("data", (chunk: Buffer) => {
              pushBytes(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            });
            res.on("end", () => {
              flushOrPause();
              safeClose();
            });
            res.on("error", () => safeClose());
          });
          activeReq = req;

          req.on("error", (err) => {
            if (streamClosed) return;
            cachedSocket = null;
            cachedHealthProbe = null;
            if (allowTcpFallback && target.kind === "unix") {
              openUpstream(resolveTcpDevdeckTarget(), false);
              return;
            }
            pushBytes(
              encoder.encode(
                `event: unavailable\ndata: ${JSON.stringify({ error: err.message })}\n\n`,
              ),
            );
            safeClose();
          });
          req.end();
        };

        onAbort = () => {
          activeReq?.destroy();
          safeClose();
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        openUpstream(initialTarget, !targetOverride);
      },
      pull(controller) {
        if (streamClosed) return;
        while (pendingChunks.length > 0 && (controller.desiredSize ?? 0) > 0) {
          const next = pendingChunks.shift()!;
          pendingBytes -= next.byteLength;
          try {
            controller.enqueue(next);
          } catch {
            activeReq?.destroy();
            streamClosed = true;
            clearStallTimer();
            detachAbort();
            return;
          }
        }
        if (pendingChunks.length === 0) {
          clearStallTimer();
          if (activeRes?.isPaused()) {
            activeRes.resume();
          }
        }
      },
      cancel() {
        streamClosed = true;
        clearStallTimer();
        detachAbort();
        pendingChunks.length = 0;
        pendingBytes = 0;
        activeRes = null;
        activeReq?.destroy();
        activeReq = null;
      },
    },
    { highWaterMark: 4 },
  );
}
