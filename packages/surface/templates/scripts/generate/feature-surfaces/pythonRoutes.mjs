/**
 * pythonRoutes.mjs: FastAPI routes, read from the Python sources (surface_python_dirs).
 *
 * The reading is pythonRoutes.py's, with Python's own ast module: it runs as
 * `python3 -I -B` on the scanned files and imports none of them, so no repo
 * code runs and no environment or .env file decides a route. A repo that
 * declares no surface_python_dirs is never scanned and needs no python3.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pythonRoutes.py");

/**
 * [{ path, method, file, texts, callers }] for the FastAPI routes in `files` (repo-relative .py paths);
 * callers are the functions of `callerFiles` (surface_python_callers) that call each route's handler.
 */
export function findPythonRoutes({ root, files, apiPrefix, prefixExprs, callerFiles = [] }) {
  if (files.length === 0) return [];
  const run = spawnSync("python3", ["-I", "-B", SCRIPT], {
    input: JSON.stringify({ root, files, apiPrefix, prefixExprs, callerFiles }),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024
  });
  if (run.error) throw new Error(`surface: surface_python_dirs is declared, but python3 cannot run: ${run.error.message}`);
  if (run.status !== 0) throw new Error(run.stderr.trim() || `surface: pythonRoutes.py exited ${run.status}`);
  return JSON.parse(run.stdout);
}
