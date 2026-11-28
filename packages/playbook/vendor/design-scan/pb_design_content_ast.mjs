// From the original playbook's design scan; only comments and the node: import style differ.
// AST and lexical bindings for UI sinks inside declared authored content.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const inContentScope = (rel, scopes = []) =>
  scopes.some((scope) => (scope.endsWith("/") ? rel.startsWith(scope) : rel === scope));
const inside = (rel, dir) => Boolean(rel && dir && (rel === dir || rel.startsWith(`${dir}/`)));
let compiler;

export function contentAst(text, rel, settings) {
  // ship-queue/ci-hosts.json provisions this host compiler. Never execute a
  // scanned branch's node_modules as part of the boundary check.
  compiler ??= NodeModule.createRequire(import.meta.url)(
    NodePath.join(NodeOS.homedir(), ".local/share/ship-queue-ci/npm/lib/node_modules/typescript"),
  );
  const ts = compiler;
  const scriptKind = /\.tsx$/.test(rel)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(rel)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind);
  if (source.parseDiagnostics.length)
    throw new Error(
      `cannot parse content source: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, " ")}`,
    );
  const unwrap = (node) => {
    while (
      node &&
      (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isSatisfiesExpression(node))
    )
      node = node.expression;
    return node;
  };
  const scopes = new Map(),
    nodeScope = new Map(),
    modulePaths = new Map([[source, rel]]),
    modules = new Map([[rel, source]]);
  const importTarget = (spec, from = rel) =>
    settings.aliasTarget?.(from, spec) ??
    (spec.startsWith(".")
      ? NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(from), spec))
      : settings.packages?.[spec]);
  const moduleKind = (spec, from) => {
    const target = importTarget(spec, from);
    if (inside(target, settings.tokens)) return "token";
    if (inside(target, settings.ui)) return "ui";
    if (
      target &&
      (inContentScope(target, settings.contentValues) ||
        [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].some((ext) =>
          inContentScope(target + ext, settings.contentValues),
        ))
    )
      return "content";
    if (/^react-native(?:-web)?(?:\/|$)/.test(spec)) return "native";
    return "external";
  };
  const declare = (name, entry, scope) => {
    if (ts.isIdentifier(name)) scopes.get(scope).set(name.text, entry);
    else
      for (const element of name.elements ?? []) {
        if (!ts.isBindingElement(element)) continue;
        const key = element.propertyName?.text ?? element.name?.text;
        declare(
          element.name,
          {
            ...entry,
            keys: [...(entry.keys ?? []), key],
            unknown:
              entry.unknown ||
              Boolean(element.dotDotDotToken || element.initializer || key === undefined),
          },
          scope,
        );
      }
  };
  const collect = (node, scope) => {
    if (
      ts.isSourceFile(node) ||
      ts.isFunctionLike(node) ||
      ts.isBlock(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node)
    ) {
      scope = node;
      scopes.set(scope, new Map());
    }
    nodeScope.set(node, scope);
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      const spec = node.moduleSpecifier.text,
        from = modulePaths.get(node.getSourceFile()),
        kind = moduleKind(spec, from),
        clause = node.importClause;
      if (clause.name) declare(clause.name, { kind, spec, from, imported: "default", node }, scope);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings))
          declare(clause.namedBindings.name, { kind, spec, from, node }, scope);
        else
          for (const item of clause.namedBindings.elements)
            if (!item.isTypeOnly)
              declare(
                item.name,
                { kind, spec, from, imported: item.propertyName?.text ?? item.name.text, node },
                scope,
              );
      }
    }
    if (ts.isVariableDeclaration(node))
      declare(
        node.name,
        { node, initializer: node.initializer, unknown: !(node.parent.flags & ts.NodeFlags.Const) },
        scope,
      );
    if (ts.isParameter(node)) {
      const call = node.parent.parent;
      const mapped =
        node.parent.parameters[0] === node &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "map";
      declare(
        node.name,
        mapped
          ? { node, initializer: call.expression.expression, elements: true }
          : { node, unknown: true },
        scope,
      );
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const parentScope = nodeScope.get(node.parent) ?? scope;
      declare(node.name, { node, kind: "content", unknown: true }, parentScope);
    }
    ts.forEachChild(node, (child) => collect(child, scope));
  };
  collect(source, source);
  const binding = (node) => {
    for (let owner = node; owner; owner = owner.parent) {
      const found = scopes.get(owner)?.get(node.text);
      if (found) return found;
    }
    return null;
  };
  const nameOf = (name) => {
    name = unwrap(name);
    if (!name) return null;
    if (ts.isComputedPropertyName(name)) {
      name = unwrap(name.expression);
      return ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : null;
    }
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
      ? name.text
      : null;
  };
  const base = (node) => {
    node = unwrap(node);
    while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
      node = unwrap(node.expression);
    return node;
  };
  const invalidate = (node, seen = new Set()) => {
    const root = base(node);
    if (root && ts.isIdentifier(root)) {
      const entry = binding(root);
      if (entry && !seen.has(entry)) {
        entry.changed = true;
        if (entry.initializer) invalidate(entry.initializer, new Set([...seen, entry]));
      }
    }
  };
  const mutations = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      invalidate(node.left);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    )
      invalidate(node.operand);
    if (ts.isDeleteExpression(node)) invalidate(node.expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (
        ["assign", "defineProperty", "defineProperties", "setPrototypeOf"].includes(
          node.expression.name.text,
        ) &&
        node.expression.expression.getText() === "Object"
      )
        invalidate(node.arguments[0]);
      if (
        [
          "push",
          "pop",
          "shift",
          "unshift",
          "splice",
          "fill",
          "copyWithin",
          "reverse",
          "sort",
        ].includes(node.expression.name.text)
      )
        invalidate(node.expression.expression);
    }
    ts.forEachChild(node, mutations);
  };
  mutations(source);
  const importedConstant = (entry) => {
    if (entry.kind !== "content" || !entry.imported) return null;
    const target = importTarget(entry.spec, entry.from);
    for (const suffix of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]) {
      const file = target + suffix;
      if (
        !settings.sourceFiles?.has(file) ||
        !inContentScope(file, settings.contentValues) ||
        file.startsWith("../") ||
        NodePath.posix.isAbsolute(file)
      )
        continue;
      let tree = modules.get(file);
      if (tree === undefined) {
        if (modules.size >= 128) return null;
        modules.set(file, null);
        try {
          const root = NodeFS.realpathSync(settings.root ?? process.cwd()),
            absolute = NodeFS.realpathSync(NodePath.join(root, file));
          if (
            absolute !== NodePath.join(root, file) ||
            !absolute.startsWith(`${root}${NodePath.sep}`)
          )
            return null;
          const info = NodeFS.statSync(absolute);
          if (!info.isFile() || info.size > 4 * 1024 * 1024) return null;
          tree = ts.createSourceFile(
            file,
            NodeFS.readFileSync(absolute, "utf8"),
            ts.ScriptTarget.Latest,
            true,
            /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
          );
          if (tree.parseDiagnostics.length) continue;
          modules.set(file, tree);
          modulePaths.set(tree, file);
          collect(tree, tree);
          mutations(tree);
        } catch {
          continue;
        }
      }
      if (!tree) continue;
      if (entry.imported === "default")
        return tree.statements.find((item) => ts.isExportAssignment(item))?.expression ?? null;
      const value = scopes.get(tree)?.get(entry.imported);
      const statement = value?.node?.parent?.parent;
      return value &&
        !value.changed &&
        !value.unknown &&
        statement?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ? value.initializer
        : null;
    }
    return null;
  };
  const property = (value, key, seen) => {
    value = resolve(value, seen);
    if (value && ts.isArrayLiteralExpression(value)) {
      const values = value.elements.map((item) => property(item, key, seen));
      return values.every(Boolean) ? ts.factory.createArrayLiteralExpression(values) : null;
    }
    if (!value || !ts.isObjectLiteralExpression(value)) return null;
    if (key === null) {
      if (
        value.properties.some(
          (field) =>
            !ts.isPropertyAssignment(field) ||
            nameOf(field.name) === null ||
            ["__proto__", "constructor", "prototype"].includes(nameOf(field.name)),
        )
      )
        return null;
      return ts.factory.createArrayLiteralExpression(
        value.properties.map((field) => field.initializer),
      );
    }
    for (const field of [...value.properties].reverse()) {
      if (ts.isSpreadAssignment(field)) return null;
      if (nameOf(field.name) !== key) continue;
      return ts.isPropertyAssignment(field)
        ? field.initializer
        : ts.isShorthandPropertyAssignment(field)
          ? field.name
          : null;
    }
    return null;
  };
  const resolve = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node || seen.has(node)) return null;
    seen = new Set([...seen, node]);
    if (ts.isIdentifier(node)) {
      const entry = binding(node);
      if (!entry || entry.changed || entry.unknown) return node;
      let value = entry.initializer ?? importedConstant(entry);
      if (!value) return node;
      if (entry.elements) {
        value = resolve(value, seen);
        if (!value || !ts.isArrayLiteralExpression(value)) return node;
      }
      for (const key of entry.keys ?? []) value = value && property(value, key, seen);
      return value && resolve(value, seen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const argument = ts.isElementAccessExpression(node) && resolve(node.argumentExpression, seen);
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
          ? argument.text
          : null;
      return property(node.expression, key, seen) ?? node;
    }
    return node;
  };
  const token = (node, seen = new Set()) => {
    node = unwrap(node);
    if (!node || seen.has(node)) return false;
    seen = new Set([...seen, node]);
    if (ts.isCallExpression(node)) return token(node.expression, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return token(node.expression, seen);
    if (!ts.isIdentifier(node)) return false;
    const entry = binding(node);
    return Boolean(
      entry &&
      !entry.changed &&
      (entry.kind === "token" ||
        (!entry.unknown && entry.initializer && token(entry.initializer, seen))),
    );
  };
  const componentKind = (tag) => {
    if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return "dom";
    const root = base(tag),
      entry = root && ts.isIdentifier(root) && binding(root);
    return entry?.kind ?? "external";
  };
  return { ts, source, unwrap, resolve, token, nameOf, binding, componentKind };
}
