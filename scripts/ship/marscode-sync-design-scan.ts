// @effect-diagnostics nodeBuiltinImport:off - Standalone post-merge installer runs from extracted base tree without Effect/node_modules.
// Installs the playbook's design scan (packages/playbook/dist/pb_design_scan.mjs, the original
// playbook's scan bundled into one file) at <prefix>/lib/playbook/pb_design_scan.mjs, the path
// repos' design evidence runs directly. A file there that MarsCode did not write (another
// install's copy) is kept, with one warning line, as marscode-sync keeps another install's CLI.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { WRAPPER_MARKER } from "./marscode-sync-parity.ts";

export const DESIGN_SCAN = "pb_design_scan.mjs";
const MARKER_LINE = `// ${WRAPPER_MARKER.slice(2)}`;

/** The design scan's bundle in a built worktree. */
export function designScanBundle(worktree: string): string {
  return NodePath.join(worktree, "packages", "playbook", "dist", DESIGN_SCAN);
}

export interface DesignScanPlaces {
  readonly worktree: string;
  /** The sync's data root: its copy survives the worktree's clean and rebuilds. */
  readonly dataRoot: string;
  /** The CLI bundles' lib dir (<libDir>/playbook/dist holds the installed release's copy). */
  readonly libDir: string;
}

/** The sync's own copy of the last built bundle. */
export function keptDesignScan(dataRoot: string): string {
  return NodePath.join(dataRoot, "design-scan", DESIGN_SCAN);
}

function copyAtomic(src: string, dest: string): void {
  NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
  const tmp = `${dest}.next.${process.pid}`;
  try {
    NodeFS.copyFileSync(src, tmp);
    NodeFS.renameSync(tmp, dest);
  } finally {
    NodeFS.rmSync(tmp, { force: true });
  }
}

/**
 * The bundle to install: a fresh build in the worktree (kept in the data root), else the
 * kept copy, else the installed playbook release's; when none is there, BUILD makes one in
 * the worktree. Null when no bundle can be had.
 */
export function designScanSource(places: DesignScanPlaces, build: () => void): string | null {
  const fresh = designScanBundle(places.worktree);
  const kept = keptDesignScan(places.dataRoot);
  if (NodeFS.existsSync(fresh)) {
    copyAtomic(fresh, kept);
    return kept;
  }
  if (NodeFS.existsSync(kept)) return kept;
  const release = NodePath.join(places.libDir, "playbook", "dist", DESIGN_SCAN);
  if (NodeFS.existsSync(release)) return release;
  build();
  if (!NodeFS.existsSync(fresh)) return null;
  copyAtomic(fresh, kept);
  return kept;
}

/** Why the file at PATH is not MarsCode's to replace; null when it is absent or MarsCode wrote it. */
function foreign(path: string): string | null {
  let st: NodeFS.Stats;
  try {
    st = NodeFS.lstatSync(path);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return `a link to ${NodeFS.readlinkSync(path)}`;
  if (!st.isFile()) return "not a regular file";
  let first: string | undefined;
  try {
    first = NodeFS.readFileSync(path, "utf8").split("\n", 1)[0];
  } catch {
    return "a file marscode-sync cannot read";
  }
  return first === MARKER_LINE ? null : "a file another install wrote";
}

/**
 * Install the design scan from WORKTREE into DIR: "installed", "current" when DIR already
 * holds this bundle, or "kept" when another install's copy (or one it cannot read) stays.
 */
export function installDesignScan(
  src: string,
  opts: {
    readonly dir: string;
    readonly log: (msg: string) => void;
    readonly warn: (msg: string) => void;
  },
): "installed" | "current" | "kept" {
  if (!NodeFS.existsSync(src)) throw new Error(`marscode-sync: missing built bundle ${src}`);
  const dest = NodePath.join(opts.dir, DESIGN_SCAN);
  const kept = foreign(dest);
  if (kept !== null) {
    opts.warn(
      `marscode-sync: warning: skipped ${DESIGN_SCAN}: kept ${dest} (${kept}, not installed by marscode-sync); remove it to let marscode-sync install its design scan.`,
    );
    return "kept";
  }
  const text = `${MARKER_LINE}\n${NodeFS.readFileSync(src, "utf8")}`;
  if (NodeFS.existsSync(dest) && NodeFS.readFileSync(dest, "utf8") === text) return "current";
  NodeFS.mkdirSync(opts.dir, { recursive: true });
  const tmp = NodePath.join(opts.dir, `.${DESIGN_SCAN}.next.${process.pid}`);
  try {
    NodeFS.writeFileSync(tmp, text, { mode: 0o644 });
    NodeFS.renameSync(tmp, dest);
  } finally {
    NodeFS.rmSync(tmp, { force: true });
  }
  opts.log(`marscode-sync: installed ${dest}`);
  return "installed";
}
