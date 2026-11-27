#!/usr/bin/env node
/**
 * Cloudflare Access + Tunnel edge provisioner for sandbox-kit.
 * Copies live policies from policySourceApp before creating DNS records; never leaves origin public.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";

const CONFIRMATION = "provision-sandbox-edge";
const API = "https://api.cloudflare.com/client/v4";
const PLAN_KEYS = [
  "zone",
  "hostname",
  "accessApp",
  "policySourceApp",
  "serviceToken",
  "tunnel",
  "probeApp",
  "probePath",
  "ingress",
  "tokenNames",
];

/** The plan from sandbox_declaration.py, checked for its keys; the declaration's checks ran there. */
export function readPlan(text) {
  const plan = JSON.parse(text);
  const missing = PLAN_KEYS.filter((key) => plan[key] === undefined);
  if (missing.length > 0) throw new Error(`state=invalid_plan missing=${missing.join(",")}`);
  return Object.freeze(plan);
}

/** The declared rules on the hostname, then 404 for everything else. */
export function ingress(plan) {
  return [
    ...plan.ingress.map((rule) => ({ hostname: plan.hostname, ...rule })),
    { service: "http_status:404" },
  ];
}

export function accessApplicationBody(plan, source) {
  return {
    name: plan.accessApp,
    domain: plan.hostname,
    type: "self_hosted",
    session_duration: source.session_duration ?? "24h",
    allowed_idps: source.allowed_idps ?? [],
    auto_redirect_to_identity: source.auto_redirect_to_identity ?? false,
    app_launcher_visible: true,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
  };
}

export function exactlyOne(items, name, kind) {
  const matches = items.filter((item) => item.name === name);
  if (matches.length > 1)
    throw new Error(
      `state=cloudflare_resource_conflict kind=${kind} name=${name} count=${matches.length}`,
    );
  return matches[0] ?? null;
}

export class CloudflareClient {
  constructor(apiToken, fetchImpl = fetch) {
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = "GET", body } = {}) {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = await response.json().catch(() => null);
    if (!response.ok || !envelope?.success) {
      const why =
        envelope?.errors?.map((error) => `${error.code}:${error.message}`).join(",") ?? "no body";
      throw new Error(
        `state=cloudflare_request_failed method=${method} path=${path} status=${response.status} errors=${why}`,
      );
    }
    return envelope.result;
  }

  async list(path) {
    const result = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100`);
    return Array.isArray(result) ? result : [];
  }
}

export function requiredEnvironment(env = process.env) {
  const apiToken = env.SANDBOX_KIT_CF_PROVISION_API_TOKEN?.trim() ?? "";
  if (!apiToken)
    throw new Error("state=missing_configuration name=SANDBOX_KIT_CF_PROVISION_API_TOKEN");
  if (env.SANDBOX_KIT_EDGE_CONFIRM !== CONFIRMATION) {
    throw new Error(`state=unconfirmed set SANDBOX_KIT_EDGE_CONFIRM=${CONFIRMATION}`);
  }
  return {
    apiToken,
    probeIps: probeAddresses(env.SANDBOX_KIT_PROBE_IPS),
    dnsApiToken: env.SANDBOX_KIT_CF_DNS_API_TOKEN?.trim() || apiToken,
    tokenFile: env.SANDBOX_KIT_TOKEN_FILE?.trim() || null,
  };
}

/**
 * Mode 0600 even when the path exists: the file is made new on each write. Lines of other names
 * that the file already holds are kept: a run that follows a failed one must not lose the
 * service token's secret, which Cloudflare returns once.
 */
function writeSecretLines(file, lines) {
  const names = new Set(lines.map((line) => line.split("=", 1)[0]));
  let held = [];
  try {
    held = NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !names.has(line.split("=", 1)[0]));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  lines = [...held, ...lines];
  NodeFS.rmSync(file, { force: true });
  NodeFS.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
}

/**
 * The machines' credential. Its secret is returned only by the request that creates it, so
 * nothing is created without a file to keep it in, and it is written before any later step.
 */
async function provisionServiceToken(plan, client, accountId, tokenFile) {
  const tokens = await client.list(`/accounts/${accountId}/access/service_tokens`);
  const existing = exactlyOne(tokens, plan.serviceToken, "service_token");
  if (existing) return { id: existing.id, lines: [] };
  if (!tokenFile)
    throw new Error(
      "state=service_token_secret_unsaved set SANDBOX_KIT_TOKEN_FILE so the new service token is kept",
    );
  const created = await client.request(`/accounts/${accountId}/access/service_tokens`, {
    method: "POST",
    body: { name: plan.serviceToken, duration: "8760h" },
  });
  const lines = [
    `${plan.tokenNames.id}=${created.client_id}`,
    `${plan.tokenNames.secret}=${created.client_secret}`,
  ];
  writeSecretLines(tokenFile, lines);
  return { id: created.id, lines };
}

/** The sandbox takes the source's people, never an open door: no bypass, and no rule for everyone or every address. */
export function refuseOpenPolicy(policy) {
  const everyone = (policy.include ?? []).some(
    (rule) => "everyone" in rule || /\/0$/.test(rule.ip?.ip ?? ""),
  );
  if (policy.decision === "bypass" || (policy.decision !== "deny" && everyone)) {
    throw new Error(`state=open_source_policy name=${policy.name} decision=${policy.decision}`);
  }
}

/**
 * The door's policies are written first and stale ones deleted after: a deny rule that changes
 * its name is never absent. The probe application is the other way (staleFirst): its stale rule
 * is a way in, and an application with no policy refuses everyone.
 */
async function writePolicies(client, policyPath, wanted, { staleFirst = false } = {}) {
  const policies = await client.list(policyPath);
  const kept = new Set(wanted.map((policy) => policy.name));
  const deleteStale = async () => {
    for (const stale of policies.filter((policy) => !kept.has(policy.name))) {
      await client.request(`${policyPath}/${stale.id}`, { method: "DELETE" });
    }
  };
  if (staleFirst) await deleteStale();
  for (const policy of wanted) {
    const existing = exactlyOne(policies, policy.name, "access_policy");
    await client.request(existing ? `${policyPath}/${existing.id}` : policyPath, {
      method: existing ? "PUT" : "POST",
      body: policy,
    });
  }
  if (!staleFirst) await deleteStale();
}

async function upsertApplication(client, accountId, existing, body) {
  return existing
    ? client.request(`/accounts/${accountId}/access/apps/${existing.id}`, { method: "PUT", body })
    : client.request(`/accounts/${accountId}/access/apps`, { method: "POST", body });
}

/** The source application and its policies, read and checked before anything is written. */
async function readSource(plan, client, accountId) {
  const apps = await client.list(`/accounts/${accountId}/access/apps`);
  const source = exactlyOne(apps, plan.policySourceApp, "access_application");
  if (!source)
    throw new Error(
      `state=missing_cloudflare_resource kind=access_application name=${plan.policySourceApp}`,
    );
  const sourcePolicies = await client.list(
    `/accounts/${accountId}/access/apps/${source.id}/policies`,
  );
  if (sourcePolicies.length === 0) throw new Error("state=source_access_app_without_policy");
  sourcePolicies.forEach(refuseOpenPolicy);
  return { apps, source, sourcePolicies };
}

async function provisionAccess(
  plan,
  client,
  accountId,
  serviceTokenId,
  { apps, source, sourcePolicies },
) {
  const existing = exactlyOne(apps, plan.accessApp, "access_application");
  if (existing && !(existing.type === "self_hosted" && existing.domain === plan.hostname)) {
    throw new Error(
      `state=cloudflare_resource_conflict kind=access_application name=${plan.accessApp}`,
    );
  }
  const app = await upsertApplication(
    client,
    accountId,
    existing,
    accessApplicationBody(plan, source),
  );
  const copied = sourcePolicies.map((from) => ({
    name: from.name,
    decision: from.decision,
    precedence: from.precedence,
    include: from.include ?? [],
    exclude: from.exclude ?? [],
    require: from.require ?? [],
  }));
  // The machines' policy: a service token, no identity.
  const machines = {
    name: plan.serviceToken,
    decision: "non_identity",
    precedence: Math.max(0, ...sourcePolicies.map((policy) => policy.precedence ?? 0)) + 1,
    include: [{ service_token: { token_id: serviceTokenId } }],
    exclude: [],
    require: [],
  };
  await writePolicies(client, `/accounts/${accountId}/access/apps/${app.id}/policies`, [
    ...copied,
    machines,
  ]);
  return sourcePolicies.length;
}

/**
 * Single hosts only, IPv4 or IPv6: a range, or a malformed address, could open the ready path
 * to others. Each becomes a /32 or /128 rule.
 */
export function probeAddresses(value = "") {
  if (value.trim() === "") return null;
  if (value.trim() === "none") return [];
  const addresses = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((address) => {
      const family = NodeNet.isIP(address);
      // No zone id, no IPv4 written as IPv6, no unspecified address: Cloudflare would refuse or misread them.
      if (
        family === 0 ||
        address.includes("%") ||
        /^::(ffff:)?[\d.]*$/i.test(address) ||
        address === "0.0.0.0"
      ) {
        throw new Error(`state=invalid_probe_address value=${address}`);
      }
      return `${address}/${family === 4 ? 32 : 128}`;
    });
  if (addresses.length === 0) throw new Error("state=invalid_probe_address value=empty");
  return addresses;
}

/** The ready path for the probe boxes and the machines' token; a refusal for everyone else. */
async function provisionProbeAccess(plan, client, accountId, serviceTokenId, probeIps) {
  if (probeIps === null) return "unchanged";
  const domain = `${plan.hostname}${plan.probePath}`;
  const apps = await client.list(`/accounts/${accountId}/access/apps`);
  const existing = exactlyOne(apps, plan.probeApp, "access_application");
  if (probeIps.length === 0) {
    if (existing)
      await client.request(`/accounts/${accountId}/access/apps/${existing.id}`, {
        method: "DELETE",
      });
    return 0;
  }
  if (existing && !(existing.type === "self_hosted" && existing.domain === domain)) {
    throw new Error(
      `state=cloudflare_resource_conflict kind=access_application name=${plan.probeApp}`,
    );
  }
  const body = {
    name: plan.probeApp,
    domain,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
  };
  const app = await upsertApplication(client, accountId, existing, body);
  await writePolicies(
    client,
    `/accounts/${accountId}/access/apps/${app.id}/policies`,
    [
      {
        name: "uptime-probe",
        decision: "bypass",
        precedence: 1,
        include: probeIps.map((ip) => ({ ip: { ip } })),
        exclude: [],
        require: [],
      },
      {
        name: plan.serviceToken,
        decision: "non_identity",
        precedence: 2,
        include: [{ service_token: { token_id: serviceTokenId } }],
        exclude: [],
        require: [],
      },
    ],
    { staleFirst: true },
  );
  return probeIps.length;
}

async function provisionTunnel(plan, client, accountId) {
  const tunnels = await client.list(
    `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${plan.tunnel}`,
  );
  const tunnel =
    exactlyOne(tunnels, plan.tunnel, "tunnel") ??
    (await client.request(`/accounts/${accountId}/cfd_tunnel`, {
      method: "POST",
      body: { name: plan.tunnel, config_src: "cloudflare" },
    }));
  await client.request(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
    method: "PUT",
    body: { config: { ingress: ingress(plan) } },
  });
  return tunnel.id;
}

async function provisionRecord(plan, client, zoneId, tunnelId) {
  const records = await client.list(`/zones/${zoneId}/dns_records?name=${plan.hostname}`);
  if (records.length > 1 || (records[0] && records[0].type !== "CNAME")) {
    throw new Error(`state=cloudflare_resource_conflict kind=dns_record name=${plan.hostname}`);
  }
  const body = {
    type: "CNAME",
    name: plan.hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    comment: `${plan.tunnel} (sandbox-kit)`,
  };
  await client.request(
    records[0] ? `/zones/${zoneId}/dns_records/${records[0].id}` : `/zones/${zoneId}/dns_records`,
    { method: records[0] ? "PUT" : "POST", body },
  );
}

export async function provision(
  plan,
  { apiToken, dnsApiToken = apiToken, tokenFile = null, probeIps = null },
  fetchImpl = fetch,
) {
  const client = new CloudflareClient(apiToken, fetchImpl);
  const zones = await client.list(`/zones?name=${plan.zone}`);
  const zone = exactlyOne(zones, plan.zone, "zone");
  if (!zone) throw new Error(`state=missing_cloudflare_resource kind=zone name=${plan.zone}`);
  const accountId = zone.account.id;

  // The people to copy are checked first; then the door, then the way in, then the name.
  const source = await readSource(plan, client, accountId);
  const serviceToken = await provisionServiceToken(plan, client, accountId, tokenFile);
  const policies = await provisionAccess(plan, client, accountId, serviceToken.id, source);
  const probes = await provisionProbeAccess(plan, client, accountId, serviceToken.id, probeIps);
  const tunnelId = await provisionTunnel(plan, client, accountId);
  if (tokenFile) {
    const token = await client.request(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
    writeSecretLines(tokenFile, [`${plan.tokenNames.tunnel}=${token}`, ...serviceToken.lines]);
  }
  await provisionRecord(plan, new CloudflareClient(dnsApiToken, fetchImpl), zone.id, tunnelId);
  return { policies, probes, tunnelId };
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const plan = readPlan(NodeFS.readFileSync(0, "utf8"));
    provision(plan, requiredEnvironment()).then(
      (result) =>
        process.stdout.write(
          `state=provisioned hostname=${plan.hostname} app=${plan.accessApp} policies=${result.policies} probe_addresses=${result.probes} tunnel=${plan.tunnel}\n`,
        ),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
