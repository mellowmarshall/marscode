import type { FleetServerItem } from "./FleetTypes.ts";

/** The server fields a peer link may see: no PIDs, command lines, paths, or images. */
export function redactPeerServerItem(srv: FleetServerItem): FleetServerItem {
  return {
    id: srv.id,
    ...(srv.project ? { project: srv.project } : {}),
    ...(srv.service ? { service: srv.service } : {}),
    kind: srv.kind,
    ...(srv.port !== undefined ? { port: srv.port } : {}),
    ...(srv.ports ? { ports: srv.ports } : {}),
    state: srv.state,
    ...(srv.cpu_pct !== undefined ? { cpu_pct: srv.cpu_pct } : {}),
    ...(srv.mem_bytes !== undefined ? { mem_bytes: srv.mem_bytes } : {}),
    ...(srv.uptime_s !== undefined ? { uptime_s: srv.uptime_s } : {}),
  };
}
