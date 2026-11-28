// @effect-diagnostics nodeBuiltinImport:off - Native HTTP route dispatcher for `/api/devtools/devdeck/*` and `/api/devtools/fleet/self`.
import type { NativeFleetService } from "./NativeFleetService.ts";

export interface NativeFleetHttpResult {
  readonly status: number;
  readonly body: unknown;
}

const SAFE_SEG = "[A-Za-z0-9._-]+";
const SERVER_ONE_RE = new RegExp(`^/api/servers/(${SAFE_SEG}(?:%2[Ff]${SAFE_SEG})?)/(start|stop)$`);
const SERVER_TWO_RE = new RegExp(`^/api/servers/(${SAFE_SEG})/(${SAFE_SEG})/(start|stop)$`);
const HOST_CI_RE = new RegExp(`^/api/hosts/(${SAFE_SEG})/ci$`);
const HOST_PROV_RE = new RegExp(`^/api/hosts/(${SAFE_SEG})/provision$`);
const ACTION_GET_RE = new RegExp(`^/api/actions/(${SAFE_SEG})$`);
const SESSION_CLOSE_RE = /^\/api\/sessions\/([A-Za-z0-9._:@%-]{1,128})\/close$/;
const NODE_KICK_RE = new RegExp(`^/api/nodes/(${SAFE_SEG})/kick$`);

export async function handleNativeFleetRequest(
  fleet: NativeFleetService,
  method: "GET" | "POST",
  devdeckApiPath: string,
  parsedBody?: Record<string, unknown>,
  /** The authenticated session subject, recorded in the CI toggle audit. */
  actor?: string,
): Promise<NativeFleetHttpResult> {
  const qIdx = devdeckApiPath.indexOf("?");
  const cleanPath = qIdx === -1 ? devdeckApiPath : devdeckApiPath.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? "" : devdeckApiPath.slice(qIdx + 1);

  if (method === "GET") {
    if (cleanPath === "/api/snapshot") {
      const panelsParam = new URLSearchParams(rawQuery).get("panels");
      const panels = panelsParam
        ? new Set(
            panelsParam
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        : undefined;
      return { status: 200, body: await fleet.getSnapshot(panels) };
    }
    if (cleanPath === "/api/nodes") {
      return { status: 200, body: fleet.getNodesMap(true) };
    }
    if (cleanPath === "/api/servers") {
      return { status: 200, body: await fleet.getServers() };
    }
    const actMatch = ACTION_GET_RE.exec(cleanPath);
    if (actMatch?.[1]) {
      const act = fleet.getAction(actMatch[1]);
      if (!act) return { status: 404, body: { error: "Action not found" } };
      return { status: 200, body: act };
    }
    return { status: 404, body: { error: "Fleet route not found" } };
  }

  if (cleanPath === "/api/hosts/check") {
    const host = typeof parsedBody?.host === "string" ? parsedBody.host.trim() : undefined;
    const actionId = fleet.triggerHostsCheck(host || undefined);
    return { status: 202, body: { action_id: actionId } };
  }

  const hostCiMatch = HOST_CI_RE.exec(cleanPath);
  if (hostCiMatch?.[1]) {
    if (typeof parsedBody?.on !== "boolean") {
      return { status: 400, body: { error: 'body must be {"on": true|false}' } };
    }
    const { confirm, confirm_at: confirmAt, client } = parsedBody;
    if (confirm !== undefined && typeof confirm !== "boolean") {
      return { status: 400, body: { error: '"confirm" must be true or false' } };
    }
    if (confirmAt !== undefined && typeof confirmAt !== "string") {
      return { status: 400, body: { error: '"confirm_at" must be a string' } };
    }
    const request = {
      confirm: confirm === true,
      confirmAt,
      actor: actor ?? "unknown",
      client: typeof client === "string" ? client : "unknown",
    };
    // Refused before an action starts, so the client sees 409 instead of a failed action.
    const refusal = fleet.refuseHostCi(hostCiMatch[1], parsedBody.on, request);
    if (refusal) {
      return {
        status: refusal.needsConfirm ? 409 : 423,
        body: { error: refusal.message, needs_confirm: refusal.needsConfirm === true },
      };
    }
    const actionId = fleet.triggerHostCi(hostCiMatch[1], parsedBody.on, request);
    return { status: 202, body: { action_id: actionId } };
  }

  const hostProvMatch = HOST_PROV_RE.exec(cleanPath);
  if (hostProvMatch?.[1]) {
    const actionId = fleet.triggerHostProvision(hostProvMatch[1]);
    return { status: 202, body: { action_id: actionId } };
  }

  const srvTwo = SERVER_TWO_RE.exec(cleanPath);
  if (srvTwo?.[1] && srvTwo[2] && (srvTwo[3] === "start" || srvTwo[3] === "stop")) {
    const targetId = `${decodeURIComponent(srvTwo[1])}/${decodeURIComponent(srvTwo[2])}`;
    const actionId = fleet.triggerServerAction(srvTwo[3], targetId, parsedBody);
    return { status: 202, body: { action_id: actionId } };
  }

  const srvOne = SERVER_ONE_RE.exec(cleanPath);
  if (srvOne?.[1] && (srvOne[2] === "start" || srvOne[2] === "stop")) {
    const targetId = decodeURIComponent(srvOne[1]);
    const actionId = fleet.triggerServerAction(srvOne[2], targetId, parsedBody);
    return { status: 202, body: { action_id: actionId } };
  }

  const sessClose = SESSION_CLOSE_RE.exec(cleanPath);
  if (sessClose?.[1]) {
    const sessionId = decodeURIComponent(sessClose[1]);
    const actionId = fleet.triggerSessionClose(sessionId);
    return { status: 202, body: { action_id: actionId } };
  }

  const kickMatch = NODE_KICK_RE.exec(cleanPath);
  if (kickMatch?.[1]) {
    return { status: 200, body: fleet.kickNode(decodeURIComponent(kickMatch[1])) };
  }

  return { status: 404, body: { error: "Fleet action not found" } };
}
