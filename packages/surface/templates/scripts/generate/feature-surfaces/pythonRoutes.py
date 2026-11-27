"""pythonRoutes.py: FastAPI routes, read from Python sources with the stdlib ast.

Run by pythonRoutes.mjs with `python3 -I -B`; it imports nothing of the repo
and reads no environment or .env file, so every host derives the same routes.
stdin is {"root", "files", "apiPrefix", "prefixExprs", "callerFiles"}; stdout
is a JSON list of {path, method, file, texts, callers}. It needs Python 3.9 or
later (ast.unparse).

The shapes it reads, and nothing more:
  r = APIRouter(prefix="/p", dependencies=[...])   (FastAPI(...) is a root)
  @r.get("/x") / post / put / patch / delete / head / options / trace,
  @r.api_route("/x", methods=[...]), @r.websocket("/x"),
  r.add_api_route("/x", h, methods=[...]) and r.add_api_websocket_route("/x", h)
  r.include_router(other, prefix="/q", dependencies=[...]); app.mount("/q", other)

A router no include reaches is a root. Every include is followed, the ones
inside `if settings.flag:` too: the surface is what the code can serve, not
what one environment turns on. A path piece is a string literal, a
module-level string constant of the same file, or, at the start of a path, an
expression the repo names in surface_python_prefix (settings.api_prefix),
which stands for its surface_api_prefix. Anything else fails the run, and so
does a route or include on an object the scan cannot resolve to a router, a
router name bound to two constructors in one file, and a methods= list that
is not a literal: never a quietly missing or misplaced route.

A route's texts are its handler as ast.unparse prints it (no comments, no
docstring) and the constructor and include calls of every router above it:
the repo's auth markers (routeAuth.mjs) are judged against them.

A route's callers come from the files the repo names in surface_python_callers
(an MCP server's tool handlers): a function there that calls a route's handler
by name, imported in the function or at the top of its file, calls that route.
The caller is named `file#name`, where name is the string key a dict literal of
the same file binds to the function (`{"get_bond": _call_get_bond}`), else the
function's own name. Only a direct call counts; a named caller file that is not
scanned, or that calls no route at all, fails the run.
"""

import ast
import copy
import json
import os
import re
import sys

METHODS = {m: m.upper() for m in ("get", "post", "put", "patch", "delete", "head", "options", "trace")}
METHODS["websocket"] = "WS"
ROUTER_TYPES = {"APIRouter", "FastAPI"}
PREFIX = object()  # a piece that stands for surface_api_prefix


def fail(msg):
    sys.stderr.write(f"surface: {msg}\n")
    sys.exit(1)


def callee_name(func):
    return func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None


def kwarg(call, name):
    return next((k.value for k in call.keywords if k.arg == name), None)


def arg(call, index, name):
    return call.args[index] if len(call.args) > index else kwarg(call, name)


def surface_path(path):
    """{id} becomes :id; {rest:path} becomes *."""
    path = re.sub(r"\{[^}:]+:path\}", "*", path)
    return re.sub(r"\{([^}:]+)(?::[^}]*)?\}", r":\1", path) or "/"


def handler_text(fn):
    body = fn.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:] or [ast.Pass()]
    clone = copy.copy(fn)
    clone.body = body
    return ast.unparse(clone)


def methods_of(call, default, where):
    node = kwarg(call, "methods")
    if node is None:
        return default
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)) and all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in node.elts):
        return sorted({e.value.upper() for e in node.elts})
    fail(f"{where}: methods={ast.unparse(node)} is not a literal list")


class Module:
    def __init__(self, rel, tree, dotted):
        self.rel, self.dotted, self.tree = rel, dotted, tree
        self.package = dotted if rel.endswith("__init__.py") else dotted.rpartition(".")[0]
        self.routers = {}    # name -> constructor call
        self.imports = {}    # local name -> absolute dotted name it binds
        self.constants = {}  # module-level name -> string literal
        self.functions = {}  # function name -> def (first one found)
        self.routes = []     # (router name, methods, call holding the path, handler text or def, line)
        self.includes = []   # (router name, included expr, prefix node, call)
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                for t in node.targets:
                    if isinstance(t, ast.Name):
                        self.constants[t.id] = node.value.value
        for node in ast.walk(tree):
            target = node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else \
                node.target if isinstance(node, ast.AnnAssign) else None
            if isinstance(target, ast.Name) and isinstance(node.value, ast.Call) and callee_name(node.value.func) in ROUTER_TYPES:
                if target.id in self.routers and self.routers[target.id] is not node.value:
                    fail(f"{rel}:{node.lineno}: {target.id} is bound to two routers in one file; the scan cannot tell them apart")
                self.routers[target.id] = node.value
            elif isinstance(node, ast.Import):
                for a in node.names:
                    if a.asname:
                        self.imports[a.asname] = a.name
            elif isinstance(node, ast.ImportFrom):
                base = self.absolute(node.module, node.level)
                for a in node.names:
                    self.imports[a.asname or a.name] = f"{base}.{a.name}" if base else a.name
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, node)
                for d in node.decorator_list:
                    if not (isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and isinstance(d.func.value, ast.Name)):
                        continue
                    where = f"{rel}:{d.lineno}"
                    if d.func.attr in METHODS:
                        self.routes.append((d.func.value.id, [METHODS[d.func.attr]], d, node, d.lineno))
                    elif d.func.attr == "api_route":
                        self.routes.append((d.func.value.id, methods_of(d, ["GET"], where), d, node, d.lineno))
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                owner, attr, where = node.func.value.id, node.func.attr, f"{rel}:{node.lineno}"
                if attr == "include_router" and node.args:
                    self.includes.append((owner, node.args[0], kwarg(node, "prefix"), node))
                elif attr == "mount" and arg(node, 1, "app") is not None:
                    self.includes.append((owner, arg(node, 1, "app"), arg(node, 0, "path"), node))
                elif attr in ("add_api_route", "add_api_websocket_route"):
                    methods = ["WS"] if attr == "add_api_websocket_route" else methods_of(node, ["GET"], where)
                    self.routes.append((owner, methods, node, arg(node, 1, "endpoint"), node.lineno))

    def absolute(self, module, level):
        if not level:
            return module or ""
        base = self.package.split(".") if self.package else []
        base = base[: len(base) - (level - 1)] if level > 1 else base
        return ".".join(base + ([module] if module else []))

    def pieces(self, node, prefix_exprs, where):
        """A path expression as literal strings and PREFIX markers; anything else fails the run."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return [node.value]
        if isinstance(node, ast.Name) and node.id in self.constants:
            return [self.constants[node.id]]
        if isinstance(node, ast.JoinedStr):
            out = []
            for v in node.values:
                out += self.pieces(v.value if isinstance(v, ast.FormattedValue) else v, prefix_exprs, where)
            return out
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return self.pieces(node.left, prefix_exprs, where) + self.pieces(node.right, prefix_exprs, where)
        if ast.unparse(node) in prefix_exprs:
            return [PREFIX]
        fail(f"{where}: the path piece {ast.unparse(node)} is not a literal; name it in surface_python_prefix if it is the API prefix")

    def path(self, node, api_prefix, prefix_exprs, where):
        if node is None:
            return ""
        parts = self.pieces(node, prefix_exprs, where)
        if PREFIX in parts[1:]:
            fail(f"{where}: the API prefix can only start a path ({ast.unparse(node)})")
        if parts and parts[0] is PREFIX:
            if not api_prefix:
                fail(f"{where}: {ast.unparse(node)} stands for surface_api_prefix, which is not declared")
            parts[0] = api_prefix
        return "".join(parts)


class Index:
    def __init__(self, root, files):
        if sys.version_info < (3, 9):
            fail("surface_python_dirs needs python3 3.9 or later (ast.unparse)")
        self.modules = []
        self.by_suffix = {}
        for rel in files:
            dotted = rel[:-3].replace("/", ".")
            if dotted.endswith(".__init__"):
                dotted = dotted[: -len(".__init__")]
            try:
                with open(os.path.join(root, rel), encoding="utf-8") as f:
                    tree = ast.parse(f.read(), rel)
            except (SyntaxError, UnicodeDecodeError, ValueError) as exc:
                fail(f"{rel}:{getattr(exc, 'lineno', 0)}: not parseable Python: {getattr(exc, 'msg', exc)}")
            mod = Module(rel, tree, dotted)
            self.modules.append(mod)
            parts = dotted.split(".")
            for i in range(len(parts)):
                self.by_suffix.setdefault(".".join(parts[i:]), []).append(mod)

    def module(self, dotted):
        """The scanned module an absolute dotted name names (a file's path ends with it), if exactly one."""
        found = self.by_suffix.get(dotted, [])
        return found[0] if len(found) == 1 else None

    def router(self, mod, name, seen=()):
        """(module, router name) a name in mod binds: a local router, or one imported from a scanned module."""
        if name in mod.routers:
            return (mod, name)
        target = mod.imports.get(name)
        if not target or (mod.rel, name) in seen:
            return None
        owner, _, attr = target.rpartition(".")
        src = self.module(owner) if owner else None
        return self.router(src, attr, seen + ((mod.rel, name),)) if src else None

    def resolve(self, mod, expr):
        if isinstance(expr, ast.Name):
            return self.router(mod, expr.id)
        if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
            target = mod.imports.get(expr.value.id)
            src = self.module(target) if target else None
            return self.router(src, expr.attr) if src else None
        return None


def tool_names(tree):
    """{function name: the string key a dict literal binds to it}, for naming callers."""
    names = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if isinstance(k, ast.Constant) and isinstance(k.value, str) and isinstance(v, ast.Name):
                    names.setdefault(v.id, k.value)
    return names


def route_callers(index, caller_files):
    """{(route handler file, handler name): [caller]} for the functions of caller_files that call a handler."""
    out = {}
    for rel in caller_files:
        mod = next((m for m in index.modules if m.rel == rel), None)
        if mod is None:
            fail(f"surface_python_callers names {rel}, which is no scanned Python file (surface_python_dirs)")
        names, found = tool_names(mod.tree), 0
        for fn in mod.tree.body:
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            local = dict(mod.imports)
            for node in ast.walk(fn):
                if isinstance(node, ast.ImportFrom):
                    base = mod.absolute(node.module, node.level)
                    for a in node.names:
                        local[a.asname or a.name] = f"{base}.{a.name}" if base else a.name
            for node in ast.walk(fn):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in local):
                    continue
                owner, _, attr = local[node.func.id].rpartition(".")
                src = index.module(owner) if owner else None
                if src is not None and (src.rel, attr) in index.handlers:
                    out.setdefault((src.rel, attr), set()).add(f"{rel}#{names.get(fn.name, fn.name)}")
                    found += 1
        if not found:
            fail(f"{rel} is named in surface_python_callers but calls no route handler")
    return out


def derive(root, files, api_prefix, prefix_exprs, caller_files=()):
    index = Index(root, files)
    index.handlers = {(m.rel, h.name if isinstance(h, (ast.FunctionDef, ast.AsyncFunctionDef)) else h.id)
                      for m in index.modules for *_, h, _line in m.routes
                      if isinstance(h, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Name))}
    callers = route_callers(index, caller_files)
    children = {}  # (rel, name) -> [(child key, prefix node, call, module)]
    included = set()
    for mod in index.modules:
        for parent, expr, prefix, call in mod.includes:
            parent_key, child = index.router(mod, parent), index.resolve(mod, expr)
            if call.func.attr == "mount" and child is None:
                continue  # a mounted ASGI app that is no router (static files): not a route surface
            if parent_key is None or child is None:
                fail(f"{mod.rel}:{call.lineno}: {ast.unparse(call.func)}({ast.unparse(expr)}) names no router the scan can find")
            key = (child[0].rel, child[1])
            children.setdefault((parent_key[0].rel, parent_key[1]), []).append((key, prefix, call, mod))
            included.add(key)
    mods = {m.rel: m for m in index.modules}
    routes_of = {}
    for mod in index.modules:
        for name, methods, call, handler, line in mod.routes:
            key = index.router(mod, name)
            if key is None:
                fail(f"{mod.rel}:{line}: a route on {name}, which the scan cannot resolve to a router")
            routes_of.setdefault((key[0].rel, key[1]), []).append((mod, methods, call, handler, line))
    out = []

    def visit(key, prefix, texts, stack):
        if key in stack:
            fail(f"{key[0]}: router {key[1]} includes itself")
        owner = mods[key[0]]
        ctor = owner.routers[key[1]]
        prefix += owner.path(kwarg(ctor, "prefix"), api_prefix, prefix_exprs, f"{key[0]}:{ctor.lineno}")
        texts = texts + [ast.unparse(ctor)]
        for mod, methods, call, handler, line in routes_of.get(key, []):
            path = surface_path(prefix + mod.path(arg(call, 0, "path"), api_prefix, prefix_exprs, f"{mod.rel}:{line}"))
            if isinstance(handler, ast.Name) and handler.id in mod.functions:
                handler = mod.functions[handler.id]
            text = handler_text(handler) if isinstance(handler, (ast.FunctionDef, ast.AsyncFunctionDef)) else ast.unparse(call)
            name = handler.name if isinstance(handler, (ast.FunctionDef, ast.AsyncFunctionDef)) else \
                handler.id if isinstance(handler, ast.Name) else None
            for method in methods:
                out.append({"path": path, "method": method, "file": mod.rel, "texts": texts + [text],
                            "callers": sorted(callers.get((mod.rel, name), [])) if name else []})
        for child, child_prefix, call, mod in children.get(key, []):
            sub = prefix + mod.path(child_prefix, api_prefix, prefix_exprs, f"{mod.rel}:{call.lineno}")
            visit(child, sub, texts + [ast.unparse(call)], stack | {key})

    for mod in index.modules:
        for name in sorted(mod.routers):
            if (mod.rel, name) not in included:
                visit((mod.rel, name), "", [], frozenset())
    out.sort(key=lambda r: (r["path"], r["method"], r["file"], r["texts"]))
    return out


def main():
    req = json.load(sys.stdin)
    json.dump(derive(req["root"], sorted(req["files"]), req.get("apiPrefix") or "", set(req.get("prefixExprs") or []),
                     sorted(req.get("callerFiles") or [])), sys.stdout)


if __name__ == "__main__":
    main()
