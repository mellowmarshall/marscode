// The design rules' scan (PLAYBOOK §10).
// From the original playbook's design scan; only comments and the node: import style differ.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { aliasResolver } from "./pb_design_aliases.mjs";
import { blankComments, scanScript } from "./pb_design_script.mjs";
import { scanJson, scanStylesheet } from "./pb_design_sheet.mjs";
import { camelProperty } from "./pb_design_values.mjs";

const SCRIPT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const STYLESHEET = /\.(css|html)$/;
const JSON_FILE = /\.json$/;
const NOT_CLIENT =
  /(^|\/)(tests?|__tests__|__mocks__|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const ASSET = /\.(png|jpe?g|gif|webp|svg|json|ttf|otf|woff2?|mp3|mp4|m4a|webm|ogg|wav|lottie)$/i;

/** The environment for one git call, as pb_diff.git_env(): no replace refs or grafts, no inherited git location or config. */
function gitEnv() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" };
  for (const name of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|REPLACE_REF_BASE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(
        name,
      )
    )
      delete env[name];
  }
  return env;
}

/** Tracked and untracked (not ignored) files in the working tree. */
export function listedFiles(root) {
  return NodeChildProcess.execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "core.quotePath=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    {
      env: gitEnv(),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter((rel) => rel && NodeFS.existsSync(NodePath.join(root, rel)));
}

/**
 * The closed list as the scans compare it: a stylesheet's property is looked
 * up by its camel name (camelProperty), so a declared CSS name (font-size)
 * also stands as its camel name (fontSize). Without it a hyphenated entry
 * matched nothing in a stylesheet. Camel entries are as declared.
 */
export function closedList(names) {
  const out = new Set(names ?? []);
  for (const name of out)
    if (!name.startsWith("--") && name.includes("-")) out.add(camelProperty(name));
  return out;
}

/** The scan's settings from the declaration's block (already validated by pb_design.py). */
export function designSettings(block) {
  return {
    tokens: block.tokens.replace(/\/+$/, ""),
    system: typeof block.system === "string" ? block.system.replace(/\/+$/, "") : null,
    ui: block.ui.replace(/\/+$/, ""),
    interactive: block.interactive ?? [],
    styleProperties: closedList(block.style_properties),
    client: block.client,
    touchCalls: new Set(block.touch_calls ?? []),
    chokepoint: Boolean(block.chokepoint),
    packages: block.packages ?? {},
  };
}

export function isClientFile(rel, scopes) {
  return (
    scopes.some((scope) => (scope.endsWith("/") ? rel.startsWith(scope) : rel === scope)) &&
    (SCRIPT.test(rel) || STYLESHEET.test(rel) || JSON_FILE.test(rel)) &&
    !NOT_CLIENT.test(rel)
  );
}

function resolveImport(spec, fromRel, known) {
  const target = fromRel
    ? NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(fromRel), spec))
    : NodePath.posix.normalize(spec);
  const candidates = [
    target,
    ...EXTENSIONS.map((ext) => target + ext),
    ...EXTENSIONS.map((ext) => `${target}/index${ext}`),
  ];
  return candidates.find((candidate) => known.has(candidate)) ?? target;
}

function runtimeImportsOf(clean, rel, aliasTarget) {
  const out = [];
  for (const m of clean.matchAll(
    /\b(?:import|export)\s+(?:([\s\S]*?)\s+from\s*)?["']([^"']+)["']/g,
  )) {
    const clause = (m[1] ?? "").trim();
    if (/^type\b(?!\s*[,{])/.test(clause)) continue;
    const namedOnly = /^\{([^}]*)\}$/.exec(clause);
    if (namedOnly) {
      const parts = namedOnly[1]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length > 0 && parts.every((p) => /^type\s+/.test(p))) continue;
    }
    const spec = m[2];
    const aliased = aliasTarget?.(rel, spec) ?? null;
    if (spec.startsWith(".") || aliased) out.push({ spec, aliased, offset: m.index });
  }
  for (const m of clean.matchAll(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = m[1];
    const aliased = aliasTarget?.(rel, spec) ?? null;
    if (spec.startsWith(".") || aliased) out.push({ spec, aliased, offset: m.index });
  }
  return out;
}

function uiImportGraphFindings(scripts, settings) {
  if (!settings.ui || !settings.tokens) return [];
  const design = NodePath.posix.dirname(settings.tokens);
  const inside = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
  const byRel = new Map(scripts.map((s) => [s.rel, s]));
  const known = new Set(byRel.keys());
  const edges = new Map();
  const importsOf = (rel) => {
    if (!edges.has(rel)) {
      const entry = byRel.get(rel);
      const list = entry
        ? runtimeImportsOf(blankComments(entry.text), rel, settings.aliasTarget)
        : [];
      edges.set(
        rel,
        list.map((item) => ({
          ...item,
          target: resolveImport(item.aliased ?? item.spec, item.aliased ? "" : rel, known),
        })),
      );
    }
    return edges.get(rel);
  };
  const isApp = (rel) => !inside(rel, settings.ui) && !inside(rel, design) && !ASSET.test(rel);
  const chainFrom = (start) => {
    const seen = new Set([start]);
    const queue = [[start]];
    while (queue.length) {
      const chain = queue.shift();
      const last = chain[chain.length - 1];
      if (isApp(last)) return chain;
      for (const { target } of importsOf(last)) {
        if (seen.has(target)) continue;
        seen.add(target);
        queue.push([...chain, target]);
      }
    }
    return null;
  };
  const findings = [];
  for (const { rel, text } of scripts) {
    if (!inside(rel, settings.ui)) continue;
    const lines = text.split("\n");
    for (const { spec, offset, target } of importsOf(rel)) {
      if (inside(target, settings.ui)) continue;
      const chain = chainFrom(target);
      if (!chain) continue;
      const line = text.slice(0, offset).split("\n").length - 1;
      findings.push({
        rule: "design/ui-imports-app",
        file: rel,
        line: line + 1,
        text: lines[line] ?? "",
        message: `the UI package reaches app code through ${spec}: ${[rel, ...chain].join(" -> ")}`,
        where: `${rel}:${line + 1}`,
      });
    }
  }
  return findings;
}

function devOnlyModules(scripts) {
  const byRel = new Map(
    scripts.map((s) => [s.rel, { text: s.text, clean: blankComments(s.text) }]),
  );
  const known = new Set(byRel.keys());
  const importers = new Map();
  const unguardedRequire = new Set();

  for (const [rel, { clean }] of byRel) {
    for (const m of clean.matchAll(/\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const target = resolveImport(m[1], rel, known);
      const lineStart = clean.lastIndexOf("\n", m.index) + 1;
      const lineText = clean.slice(lineStart, m.index);
      if (!/\b__DEV__\b/.test(lineText)) unguardedRequire.add(target);
    }
    for (const m of clean.matchAll(/\bexport\s+[^;\n]*?\bfrom\s*["'](\.[^"']+)["']/g)) {
      unguardedRequire.add(resolveImport(m[1], rel, known));
    }
    for (const m of clean.matchAll(/\bimport\s+([^;\n]+?)\s+from\s*["'](\.[^"']+)["']/g)) {
      const clause = m[1].trim();
      if (/^type\b/.test(clause)) continue;
      const target = resolveImport(m[2], rel, known);
      if (!known.has(target)) continue;
      const names = [];
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) {
        for (const p of named[1].split(",")) {
          const trimmed = p.trim();
          if (!trimmed || /^type\s+/.test(trimmed)) continue;
          const parts = trimmed.split(/\s+as\s+/);
          const local = (parts[1] ?? parts[0]).trim();
          if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
        }
      }
      const def = clause.split(/[*{]/)[0].replace(/,\s*$/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(def)) names.push(def);
      if (!importers.has(target)) importers.set(target, []);
      importers.get(target).push({ caller: rel, names });
    }
  }

  const devOnly = new Set();
  for (const [target, refs] of importers) {
    if (unguardedRequire.has(target) || refs.length === 0) continue;
    let allGuarded = true;
    for (const { caller, names } of refs) {
      const { clean } = byRel.get(caller);
      if (names.length === 0 || /\b(?:const|let|var)\s+__DEV__\b/.test(clean)) {
        allGuarded = false;
        break;
      }
      for (const name of names) {
        const tagUses = [...clean.matchAll(new RegExp(`<${name}\\b`, "g"))];
        if (tagUses.length === 0) {
          allGuarded = false;
          break;
        }
        for (const u of tagUses) {
          const lineStart = clean.lastIndexOf("\n", u.index) + 1;
          const prevLineStart = clean.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
          const windowText = clean.slice(prevLineStart, u.index);
          const sameLine = clean.slice(lineStart, u.index);
          const exprText = /\b__DEV__\b/.test(sameLine) ? sameLine : windowText;
          const hasDevBefore = /\b__DEV__\b/.test(exprText);
          const devIdx = exprText.lastIndexOf("__DEV__");
          const afterDev = devIdx >= 0 ? exprText.slice(devIdx) : "";
          const qIdx = afterDev.indexOf("?");
          const afterColon = qIdx >= 0 && afterDev.slice(qIdx + 1).includes(":");
          if (!hasDevBefore || afterColon || /;/.test(afterDev)) {
            allGuarded = false;
            break;
          }
        }
      }
    }
    if (allGuarded) devOnly.add(target);
  }
  return devOnly;
}

/** Every finding in the client files of `root`. */
export function designFindings(root, settings, emitted) {
  settings.aliasTarget ??= aliasResolver(root);
  const listed = listedFiles(root);
  const sources = listed
    .filter((rel) => isClientFile(rel, settings.client))
    .map((rel) => ({ rel, text: NodeFS.readFileSync(NodePath.join(root, rel), "utf8") }));
  const scanned = sources.filter(({ rel }) => !emitted.has(rel));
  if (settings.chokepoint) {
    return { findings: [], files: scanned.length };
  }
  const findings = [];
  for (const { rel, text } of scanned.filter(({ rel }) => STYLESHEET.test(rel)))
    findings.push(...scanStylesheet(text, rel, settings));
  const inTokens = (rel) => rel.startsWith(`${settings.tokens}/`);
  for (const { rel, text } of scanned.filter(({ rel }) => JSON_FILE.test(rel) && !inTokens(rel)))
    findings.push(...scanJson(text, rel, settings));
  const scripts = scanned.filter(({ rel }) => SCRIPT.test(rel));
  if (scripts.length) {
    for (const { rel, text } of scripts) {
      findings.push(...scanScript(text, rel, settings));
    }
    findings.push(...uiImportGraphFindings(scripts, settings));
    const devOnly = devOnlyModules(scripts);
    return {
      findings: findings.filter((finding) => !devOnly.has(finding.file)),
      files: scanned.length,
    };
  }
  return { findings, files: scanned.length };
}

function workspacePackages(root) {
  const out = {};
  for (const rel of listedFiles(root)) {
    if (NodePath.posix.basename(rel) !== "package.json" || `/${rel}`.includes("node_modules/"))
      continue;
    try {
      const name = JSON.parse(NodeFS.readFileSync(NodePath.join(root, rel), "utf8")).name;
      if (typeof name === "string" && name) out[name] = NodePath.posix.dirname(rel) || ".";
    } catch {
      /* ignore malformed package.json */
    }
  }
  return out;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  let root;
  let settings;
  let generated;
  if (raw) {
    const input = JSON.parse(raw);
    root = input.root;
    settings = designSettings(input.settings);
    generated = new Set(input.generated ?? []);
  } else {
    root = process.cwd();
    const decl = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "playbook.json"), "utf8"));
    const s = decl?.contracts?.design ?? {};
    settings = designSettings({ ...s, packages: workspacePackages(root) });
    generated = new Set();
  }
  const result = designFindings(root, settings, generated);
  process.stdout.write(JSON.stringify(result));
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodePath.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(2);
  });
}
