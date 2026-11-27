/**
 * axumRoutes.mjs: axum routes, read from the Rust sources (surface_rust_dirs).
 *
 * Each fn whose body builds a router holds its `.route(path, get(h).post(h2))`
 * calls, the routers it takes in with `.merge(x::router())` and
 * `.nest("/p", x::router())`, and its `.layer(...)` / `.route_layer(...)`
 * calls. A router no other router merges or nests is a root; every route is
 * reached from a root, so a nested route carries its prefix and a merged one
 * is counted once. Paths take the surface form: {id} and :id become :id,
 * {*rest} and *rest become *.
 *
 * A route's file is its handler's (the router's, for a closure).
 * For the auth level each route keeps the text that decides it: its handler
 * fn (signature and body, found by name, by module file when the handler is
 * `module::name`), its method's own `.layer(...)`, and every layer added after
 * it on its router or a router that takes it in (axum applies a layer to the
 * routes added before it).
 *
 * A `.nest` of anything but a fn call (a router held in a local variable)
 * cannot be followed, so it fails the run rather than mislabel the paths.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { functions, splitArgs, stringLiteral, stripRust } from "./rustSource.mjs";

const METHODS = { get: "GET", post: "POST", put: "PUT", delete: "DELETE", patch: "PATCH", head: "HEAD",
  options: "OPTIONS", trace: "TRACE", any: "ANY", get_service: "GET", post_service: "POST", any_service: "ANY" };
const EVENT = /\.\s*(route|route_service|nest|nest_service|merge|layer|route_layer)\s*(?:::\s*<[^>]*>\s*)?\(/g;

function axumPath(path) {
  return path.replace(/\{\*[^}]*\}|(^|\/)\*[^/]*/g, (m, lead) => (m.startsWith("{") ? "*" : `${lead}*`))
    .replace(/\{([^}]+)\}/g, ":$1") || "/";
}

function stemOf(file) {
  const parts = file.replace(/\.rs$/, "").split("/");
  const last = parts.pop();
  return last === "mod" ? parts.pop() : last;
}

/** fn name -> [{ file, fn, text }] across every scanned file. */
function indexFunctions(files, root) {
  const byName = new Map();
  const perFile = [];
  for (const file of files) {
    const text = stripRust(readFileSync(join(root, file), "utf8"));
    const fns = functions(text);
    perFile.push({ file, text, fns });
    for (const fn of fns) {
      if (!byName.has(fn.name)) byName.set(fn.name, []);
      byName.get(fn.name).push({ file, fn, text });
    }
  }
  return { byName, perFile };
}

/** The fn a `module::name` (or bare `name`) path names, seen from `fromFile`. */
function resolve(byName, pathText, fromFile) {
  const segs = pathText.split("::").map((s) => s.trim()).filter(Boolean);
  const name = segs.pop();
  const candidates = byName.get(name) || [];
  if (candidates.length === 0) return null;
  const module = segs.filter((s) => !["crate", "self", "super"].includes(s)).pop();
  if (!module) {
    return candidates.find((c) => c.file === fromFile) || (candidates.length === 1 ? candidates[0] : null);
  }
  const inModule = candidates.filter((c) => stemOf(c.file) === module);
  if (inModule.length === 1) return inModule[0];
  // A module dir that re-exports its files (users/mod.rs: pub use list::*).
  const underModule = candidates.filter((c) => c.file.includes(`/${module}/`));
  return underModule.length === 1 ? underModule[0] : candidates.length === 1 ? candidates[0] : null;
}

/** The method handlers in a method-router expression: get(a).post(b), on(MethodFilter::PUT, c), ... */
function methodHandlers(expr) {
  const found = [];
  const layers = [];
  const re = /(?:^|[^\w:])((?:\w+\s*::\s*)*)(\w+)\s*\(/g;
  for (let m = re.exec(expr); m !== null; m = re.exec(expr)) {
    const name = m[2];
    const open = m.index + m[0].length - 1;
    const { args, end } = splitArgs(expr, open);
    if (METHODS[name]) {
      found.push({ method: METHODS[name], handler: args[0]?.text || "" });
    } else if (name === "on" && args.length >= 2) {
      for (const f of args[0].text.matchAll(/MethodFilter\s*::\s*([A-Z]+)/g)) found.push({ method: f[1], handler: args[1].text });
    } else if (name === "layer" || name === "route_layer") {
      layers.push(expr.slice(open, end));
    } else {
      continue;
    }
    re.lastIndex = end;
  }
  return { found, layers };
}

/** The handler's text (its fn, or the closure itself) and the file that holds it. */
function handlerOf(byName, handler, fromFile) {
  const h = handler.trim();
  if (/^(move\b|async\b|\|)/.test(h)) return { text: h, file: fromFile };
  const path = /^((?:\w+\s*::\s*)*\w+)/.exec(h);
  const target = path && resolve(byName, path[1], fromFile);
  return target ? { text: target.text.slice(target.fn.start, target.fn.end), file: target.file } : { text: h, file: fromFile };
}

function calledFn(expr) {
  const m = /^\s*((?:\w+\s*::\s*)*\w+)\s*(?:::\s*<[^>]*>\s*)?\(/.exec(expr);
  return m ? m[1] : null;
}

/** The router events of one fn body, in source order, skipping fns nested inside it. */
function routerEvents(entry, fn, byName) {
  const { file, text, fns } = entry;
  const inner = fns.filter((f) => f !== fn && f.start > fn.bodyStart && f.end <= fn.end);
  const events = [];
  EVENT.lastIndex = fn.bodyStart;
  for (let m = EVENT.exec(text); m !== null && m.index < fn.end; m = EVENT.exec(text)) {
    if (inner.some((f) => m.index >= f.start && m.index < f.end)) continue;
    const open = m.index + m[0].length - 1;
    const { args, end } = splitArgs(text, open);
    const at = m.index;
    const kind = m[1];
    if (kind === "route" || kind === "route_service") {
      const path = args[0] && stringLiteral(args[0].text);
      if (path !== null && path !== undefined) {
        const { found, layers } = kind === "route" ? methodHandlers(args[1]?.text || "") : { found: [{ method: "ANY", handler: "" }], layers: [] };
        for (const f of found) {
          const h = handlerOf(byName, f.handler, file);
          events.push({ at, kind: "route", path: axumPath(path), method: f.method, handlerFile: h.file, texts: [h.text, ...layers] });
        }
      }
    } else if (kind === "nest" || kind === "merge") {
      const prefix = kind === "nest" ? stringLiteral(args[0]?.text || "") : "";
      const expr = (kind === "nest" ? args[1] : args[0])?.text || "";
      const callee = calledFn(expr);
      const child = callee && resolve(byName, callee, file);
      if (kind === "nest" && (prefix === null || !callee)) {
        throw new Error(`surface: ${file}: .nest(${args.map((a) => a.text).join(", ")}) does not nest a fn call with a literal path; ` +
          "the surface cannot follow it (build the nested router in its own fn)");
      }
      if (child) events.push({ at, kind: "child", prefix: prefix ? axumPath(prefix).replace(/\/$/, "") : "", child });
    } else if (kind === "layer" || kind === "route_layer") {
      events.push({ at, kind: "layer", text: text.slice(open, end) });
    }
    EVENT.lastIndex = Math.max(EVENT.lastIndex, open + 1);
  }
  return events;
}

/**
 * @param {{ root: string, files: string[] }} opts  repo root and repo-relative .rs files
 * @returns {{ path: string, method: string, file: string, texts: string[] }[]}  file: the handler's
 */
export function findAxumRoutes({ root, files }) {
  const { byName, perFile } = indexFunctions(files, root);
  const routers = new Map(); // "file#start" -> { entry, fn, events }
  const keyOf = (file, fn) => `${file}#${fn.start}`;
  for (const entry of perFile) {
    for (const fn of entry.fns) {
      const events = routerEvents(entry, fn, byName);
      if (events.some((e) => e.kind !== "layer")) routers.set(keyOf(entry.file, fn), { file: entry.file, events });
    }
  }
  const taken = new Set();
  for (const r of routers.values()) {
    for (const e of r.events) if (e.kind === "child") taken.add(keyOf(e.child.file, e.child.fn));
  }

  const out = [];
  const expand = (key, prefix, outerTexts, seen) => {
    const r = routers.get(key);
    if (!r || seen.has(key)) return;
    const layersAfter = (at) => r.events.filter((e) => e.kind === "layer" && e.at > at).map((e) => e.text);
    for (const e of r.events) {
      if (e.kind === "route") {
        const path = (prefix + (e.path === "/" && prefix ? "" : e.path)) || "/";
        out.push({ path, method: e.method, file: e.handlerFile, texts: [...e.texts, ...layersAfter(e.at), ...outerTexts] });
      } else if (e.kind === "child") {
        expand(keyOf(e.child.file, e.child.fn), prefix + e.prefix, [...layersAfter(e.at), ...outerTexts], new Set([...seen, key]));
      }
    }
  };
  for (const key of routers.keys()) {
    if (!taken.has(key)) expand(key, "", [], new Set());
  }
  return out;
}
