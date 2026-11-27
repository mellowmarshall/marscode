/**
 * codeMap.mjs: A symbol and import map of the scanned sources (derive --code-map).
 *
 * For each file: the names it exports, the modules it imports (a repo file when the
 * specifier resolves inside the repo, else the bare specifier) with the names it
 * takes from each, and the repo files that import it. Specifiers resolve through the
 * nearest tsconfig.json, so `paths` aliases land on the file they name.
 *
 * It needs the TypeScript compiler API; there is no regular-expression fallback.
 * The map is printed, not written into the feature-surface contract: it changes with
 * every import edit, and the contract's drift gate should fail only on route changes.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseSource } from "./sourceScanner.mjs";

function compilerOptionsFor(ts, root, file, cache) {
  let dir = dirname(join(root, file));
  const seen = [];
  while (dir.startsWith(root)) {
    if (cache.has(dir)) break;
    seen.push(dir);
    const tsconfig = join(dir, "tsconfig.json");
    if (existsSync(tsconfig)) {
      const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, dir);
      cache.set(dir, parsed.options);
      break;
    }
    if (dir === root) {
      cache.set(dir, {});
      break;
    }
    dir = dirname(dir);
  }
  const options = cache.get(dir) ?? {};
  for (const d of seen) cache.set(d, options);
  return options;
}

function exportedSymbols(ts, sf) {
  const names = new Set();
  for (const stmt of sf.statements) {
    const exported = (ts.getModifiers?.(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = (ts.getModifiers?.(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isExportAssignment(stmt)) names.add("default");
    else if (ts.isExportDeclaration(stmt)) {
      if (!stmt.exportClause) names.add("*");
      else if (ts.isNamespaceExport(stmt.exportClause)) names.add(stmt.exportClause.name.text);
      else for (const el of stmt.exportClause.elements) names.add(el.name.text);
    } else if (exported && isDefault) names.add("default");
    else if (exported && ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    } else if (exported && stmt.name && ts.isIdentifier(stmt.name)) names.add(stmt.name.text);
  }
  return [...names].sort();
}

function importedNames(ts, stmt) {
  if (ts.isExportDeclaration(stmt)) {
    if (!stmt.exportClause) return ["*"];
    if (ts.isNamespaceExport(stmt.exportClause)) return ["*"];
    return stmt.exportClause.elements.map((el) => (el.propertyName ?? el.name).text);
  }
  const clause = stmt.importClause;
  if (!clause) return [];
  const names = [];
  if (clause.name) names.push("default");
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
    else for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

export function buildCodeMap(ts, root, files) {
  const optionsCache = new Map();
  const map = {};
  for (const file of files) {
    const sf = parseSource(ts, file, readFileSync(join(root, file), "utf8"));
    const options = compilerOptionsFor(ts, root, file, optionsCache);
    const imports = [];
    for (const stmt of sf.statements) {
      if (!(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) || !stmt.moduleSpecifier) continue;
      const spec = stmt.moduleSpecifier.text;
      const resolved = ts.resolveModuleName(spec, join(root, file), options, ts.sys).resolvedModule;
      // A relative specifier TS cannot resolve (a .css module, an asset) still names a repo file.
      const resolvedFile = resolved && !resolved.isExternalLibraryImport ? resolved.resolvedFileName
        : spec.startsWith(".") ? join(dirname(join(root, file)), spec) : null;
      const target = resolvedFile ? relative(root, resolvedFile) : null;
      const inRepo = target !== null && !target.startsWith("..");
      imports.push({ from: inRepo ? target.replace(/\\/g, "/") : spec, external: !inRepo, names: importedNames(ts, stmt).sort() });
    }
    map[file] = { exports: exportedSymbols(ts, sf), imports, importedBy: [] };
  }
  for (const [file, entry] of Object.entries(map)) {
    for (const imp of entry.imports) {
      if (!imp.external && map[imp.from] && !map[imp.from].importedBy.includes(file)) map[imp.from].importedBy.push(file);
    }
  }
  for (const entry of Object.values(map)) entry.importedBy.sort();
  return {
    meta: { generatedAt: "build-time", version: 1, totalFiles: files.length },
    files: map
  };
}
