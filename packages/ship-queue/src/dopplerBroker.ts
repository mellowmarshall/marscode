// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Doppler CI read-only token broker and CI secret allowlist.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const DOPPLER_API_BASE = "https://api.doppler.com";
const TOKEN_EXPIRE_S = 4 * 3600;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const CI_SECRET_NAMES: ReadonlySet<string> = new Set([
  "CLOUDFLARE_API_TOKEN",
  "DOPPLER_TOKEN",
  "FLY_API_TOKEN",
  "HCLOUD_TOKEN",
  "NEON_API_KEY",
  "OP_SERVICE_ACCOUNT_TOKEN",
]);

export interface DopplerTokenRecord {
  readonly project: string;
  readonly config: string;
  readonly slug: string;
}

export interface DopplerHttpResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export type DopplerHttpClient = (input: {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly token: string;
  readonly body?: Record<string, unknown> | undefined;
}) => Promise<DopplerHttpResponse>;

export interface MintDopplerResult {
  readonly envVars: Readonly<Record<string, string>>;
  readonly records: ReadonlyArray<DopplerTokenRecord>;
}

export function dopplerEnvName(prefix: string, ...parts: ReadonlyArray<string>): string {
  return prefix + parts.map((p) => p.toUpperCase().replace(/[^A-Z0-9]/g, "_")).join("_");
}

function formatDopplerMessages(body: Record<string, unknown>): string {
  const msgs = body.messages;
  if (Array.isArray(msgs) && msgs.length > 0) {
    return msgs.map((m) => String(m)).join("; ");
  }
  return "no message";
}

function redactToken(message: string, loginToken: string): string {
  if (!loginToken) return message;
  return message.replaceAll(loginToken, "[REDACTED]");
}

function writeTokenRecords(recordsPath: string, records: ReadonlyArray<DopplerTokenRecord>): void {
  const dir = NodePath.dirname(recordsPath);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${recordsPath}.tmp.${process.pid}`;
  NodeFS.writeFileSync(tmp, JSON.stringify(records), { mode: 0o600 });
  NodeFS.renameSync(tmp, recordsPath);
}

export function readDopplerTokenRecords(recordsPath: string): ReadonlyArray<DopplerTokenRecord> {
  if (!NodeFS.existsSync(recordsPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(recordsPath, "utf8")) as unknown;
  } catch {
    throw new Error(`${recordsPath} is not a record list; its tokens expire on their own`);
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (r): r is DopplerTokenRecord =>
      Boolean(r && typeof r === "object") &&
      typeof (r as Record<string, unknown>).project === "string" &&
      typeof (r as Record<string, unknown>).config === "string" &&
      typeof (r as Record<string, unknown>).slug === "string",
  );
}

export const defaultDopplerHttpClient: DopplerHttpClient = async ({
  method,
  path,
  token,
  body,
}) => {
  const res = await fetch(`${DOPPLER_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  let jsonBody: Record<string, unknown> = {};
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      jsonBody = parsed as Record<string, unknown>;
    }
  } catch {
    // non-JSON response body
  }
  return { status: res.status, body: jsonBody };
};

async function listProjectConfigs(
  http: DopplerHttpClient,
  loginToken: string,
  project: string,
): Promise<ReadonlyArray<string>> {
  const names = new Set<string>();
  let page = 1;
  for (;;) {
    const res = await http({
      method: "GET",
      path: `/v3/configs?project=${encodeURIComponent(project)}&page=${page}&per_page=100`,
      token: loginToken,
    });
    if (res.status !== 200) {
      throw new Error(
        `cannot list the configs of ${project}: HTTP ${res.status} (${formatDopplerMessages(res.body)})`,
      );
    }
    const rows = res.body.configs;
    if (!Array.isArray(rows)) {
      throw new Error(`the configs of ${project} came back in an unexpected shape`);
    }
    let count = 0;
    for (const row of rows) {
      if (
        row &&
        typeof row === "object" &&
        typeof (row as Record<string, unknown>).name === "string"
      ) {
        const name = (row as Record<string, unknown>).name as string;
        if (name) {
          names.add(name);
          count += 1;
        }
      }
    }
    if (count < 100) return [...names].toSorted();
    page += 1;
  }
}

/**
 * Revokes every Doppler service token recorded at `recordsPath`.
 * HTTP 200 and 404 count as revoked; any remaining failures stay written for retry.
 */
export async function revokeDopplerTokens(input: {
  readonly loginToken: string;
  readonly recordsPath: string;
  readonly http?: DopplerHttpClient | undefined;
}): Promise<{ readonly errors: ReadonlyArray<string> }> {
  const http = input.http ?? defaultDopplerHttpClient;
  const records = readDopplerTokenRecords(input.recordsPath);
  const left: DopplerTokenRecord[] = [];
  const errors: string[] = [];

  for (const r of records) {
    try {
      const res = await http({
        method: "DELETE",
        path: "/v3/configs/config/tokens/token",
        token: input.loginToken,
        body: { project: r.project, config: r.config, slug: r.slug },
      });
      if (res.status !== 200 && res.status !== 404) {
        left.push(r);
        errors.push(
          redactToken(
            `cannot revoke the read token for ${r.project}/${r.config}: HTTP ${res.status} (${formatDopplerMessages(res.body)})`,
            input.loginToken,
          ),
        );
      }
    } catch (err) {
      left.push(r);
      errors.push(
        redactToken(
          `cannot revoke the read token for ${r.project}/${r.config}: ${err instanceof Error ? err.message : String(err)}`,
          input.loginToken,
        ),
      );
    }
  }

  if (left.length > 0) {
    writeTokenRecords(input.recordsPath, left);
  } else if (NodeFS.existsSync(input.recordsPath)) {
    NodeFS.rmSync(input.recordsPath, { force: true });
  }
  return { errors };
}

/**
 * Mints short-lived read-only Doppler service tokens for one CI job.
 * Records every minted token slug BEFORE returning keys, and revokes partial mints on any error.
 */
export async function mintDopplerTokens(input: {
  readonly loginToken: string;
  readonly jobId: string;
  readonly recordsPath: string;
  readonly pairs: ReadonlyArray<string>;
  readonly nowEpochSec: number;
  readonly http?: DopplerHttpClient | undefined;
}): Promise<MintDopplerResult> {
  if (!input.loginToken.trim()) {
    throw new Error("no Doppler login token supplied");
  }
  const wanted: Array<readonly [string, string]> = [];
  for (const pair of input.pairs) {
    const slash = pair.indexOf("/");
    const project = slash >= 0 ? pair.slice(0, slash) : "";
    const config = slash >= 0 ? pair.slice(slash + 1) : "";
    if (!SLUG_RE.test(project) || !SLUG_RE.test(config)) {
      throw new Error(`'${pair}' is not PROJECT/CONFIG`);
    }
    wanted.push([project, config]);
  }

  const http = input.http ?? defaultDopplerHttpClient;
  const records: DopplerTokenRecord[] = [...readDopplerTokenRecords(input.recordsPath)];
  const envVars: Record<string, string> = {};

  try {
    for (const [project, config] of wanted) {
      const res = await http({
        method: "POST",
        path: "/v3/configs/config/tokens",
        token: input.loginToken,
        body: {
          project,
          config,
          name: `ship-queue-job-${input.jobId}`,
          access: "read",
          expire_at: Math.floor(input.nowEpochSec) + TOKEN_EXPIRE_S,
        },
      });
      const tokenObj =
        res.body.token && typeof res.body.token === "object" && !Array.isArray(res.body.token)
          ? (res.body.token as Record<string, unknown>)
          : null;
      if (tokenObj && typeof tokenObj.slug === "string" && tokenObj.slug) {
        records.push({ project, config, slug: tokenObj.slug });
        writeTokenRecords(input.recordsPath, records);
      }
      if (
        res.status !== 200 ||
        !tokenObj ||
        tokenObj.access !== "read" ||
        typeof tokenObj.key !== "string" ||
        !tokenObj.key.startsWith("dp.st.") ||
        typeof tokenObj.slug !== "string" ||
        !tokenObj.slug ||
        !tokenObj.expires_at
      ) {
        throw new Error(
          `cannot mint a read token for ${project}/${config} that expires: HTTP ${res.status} (${formatDopplerMessages(res.body)})`,
        );
      }
      envVars[dopplerEnvName("DOPPLER_TOKEN_", project, config)] = tokenObj.key;
    }

    const projects = [...new Set(wanted.map(([p]) => p))].toSorted();
    for (const project of projects) {
      const configs = await listProjectConfigs(http, input.loginToken, project);
      envVars[dopplerEnvName("DOPPLER_CONFIGS_", project)] = configs.join(",");
    }
  } catch (err) {
    await revokeDopplerTokens({
      loginToken: input.loginToken,
      recordsPath: input.recordsPath,
      http,
    });
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(redactToken(msg, input.loginToken), { cause: err });
  }

  return { envVars, records };
}

/** Formats CI secrets for delivery strictly over SSH stdin (never argv), terminated by a blank line. */
export function formatSecretStdinPayload(
  secrets: Readonly<Record<string, string>>,
  withheld = false,
): string {
  if (withheld) return "\n";
  const lines: string[] = [];
  for (const key of Object.keys(secrets).toSorted()) {
    const val = secrets[key] ?? "";
    if (!/^[A-Z0-9_]+$/.test(key) || /[\r\n\0]/.test(key)) {
      throw new Error(`invalid secret variable name: ${JSON.stringify(key)}`);
    }
    if (/[\r\n\0]/.test(val)) {
      throw new Error(`secret ${key} contains forbidden CR, LF, or NUL characters`);
    }
    lines.push(`${key}=${val}`);
  }
  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}\n`;
}
