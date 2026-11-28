// Vendored verbatim from the original playbook's design scan; only comments differ.
/**
 * Fast script scanner for `playbook check design` (PLAYBOOK §10):
 * checks token literals, custom properties, interactive primitives, and touch
 * targets. Declared content sources add AST-based proof of their UI sinks.
 */
import { scanEmbeddedCss } from "./pb_design_sheet.mjs";
import { rendererValues } from "./pb_design_renderer.mjs";
import { ensureDesignContext } from "./pb_design_renderer_package.mjs";
import { contentUiFindings } from "./pb_design_content.mjs";
import { SUBSTITUTION, arbitraryClasses, hasScriptColorSyntax, isColorProperty, isNamedColor, isTokenReference } from "./pb_design_values.mjs";

const TOUCH_PRIMITIVES = new Set([
  "Pressable", "TouchableOpacity", "TouchableHighlight", "TouchableWithoutFeedback",
  "TouchableNativeFeedback", "TextInput", "Switch", "Button"
]);
const RAW_PRIMITIVES = new Set([...TOUCH_PRIMITIVES, "Modal", "PanResponder", "Animated"]);
const INTERACTIVE_PACKAGES = [
  "react-native-gesture-handler", "react-native-reanimated", "react-native-worklets",
  "framer-motion", "@gorhom/bottom-sheet", "expo-router"
];
const WEB_ELEMENTS = new Set(["button", "a", "input", "select", "textarea"]);
const WEB_LINKS = new Set(["Link", "NavLink"]);
const isRouterSource = (spec) => spec === "react-router" || spec === "react-router-dom";
const isPrimitiveSource = (spec) => spec === "react-native" || spec === "react-native-web" || spec.startsWith("react-native/") || spec.startsWith("react-native-web/");
const isInteractivePackage = (spec) => INTERACTIVE_PACKAGES.some((name) => spec === name || spec.startsWith(`${name}/`));

const PASSIVE_PROP = new Set([
  "onLayout", "onTextLayout", "onContentSizeChange", "onLoad", "onLoadStart", "onLoadEnd",
  "onLoadedData", "onLoadedMetadata", "onError", "onMountError", "onProgress", "onEnded",
  "onPlaybackStatusUpdate", "onFirstFrameRender", "onDisplay", "onCameraReady", "onBarcodeScanned",
  "onAnimationStart", "onAnimationEnd", "onAnimationIteration", "onTransitionStart", "onTransitionEnd",
  "onScroll", "onScrollToIndexFailed", "onViewableItemsChanged", "onEndReached", "onEndReachedThreshold"
]);
const isInteractionProp = (name) => /^on[A-Z]\w*$/.test(name) && !PASSIVE_PROP.has(name);
const isQuoteOpen = (s, i) => s[i] === "`" || s[i] === '"' || (s[i] === "'" && (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1])));

/** Blank // and /* comments with spaces while keeping newlines and string literals intact. */
export function blankComments(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (isQuoteOpen(src, i)) {
      const q = ch;
      out += ch;
      i += 1;
      while (i < src.length && src[i] !== q && (q === "`" || src[i] !== "\n")) {
        out += src[i] === "\\" ? src.slice(i, (i += 2)) : src[i++];
      }
      if (i < src.length && src[i] === q) out += src[i++];
    } else if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") { out += " "; i += 1; }
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let j = i; j < stop; j += 1) out += src[j] === "\n" ? "\n" : " ";
      i = stop;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function skipQuoted(s, start) {
  const q = s[start];
  let i = start + 1;
  while (i < s.length && s[i] !== q && (q === "`" || s[i] !== "\n")) {
    if (s[i] === "\\") i += 2;
    else if (q === "`" && s.startsWith("${", i)) {
      i += 2;
      for (let d = 1; i < s.length && d > 0; ) {
        if (isQuoteOpen(s, i)) i = skipQuoted(s, i) + 1;
        else { if (s[i] === "{") d += 1; else if (s[i] === "}") d -= 1; i += 1; }
      }
    } else i += 1;
  }
  return i;
}

function splitCallArgs(s, openParen) {
  const args = [];
  let d = 0, start = openParen + 1;
  for (let i = openParen; i < s.length; i += 1) {
    const ch = s[i];
    if (isQuoteOpen(s, i)) { i = skipQuoted(s, i); continue; }
    if (ch === "(" || ch === "[" || ch === "{") d += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--d === 0) { args.push(s.slice(start, i).trim()); return { args, end: i + 1 }; }
    } else if (ch === "," && d === 1) { args.push(s.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

function hasNonBinaryNumber(expr) {
  const withoutStrings = expr.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, " ");
  for (const m of withoutStrings.matchAll(/(?<![\w$.])-?(?:0\.[0-9]+|[0-9]+(?:\.[0-9]+)?)(?![\w$])/g)) {
    if (m[0] !== "0" && m[0] !== "1") return m[0];
  }
  return null;
}

export function blankStrings(src) {
  const chars = src.split("");
  const maskQuoted = (start) => {
    const q = chars[start];
    chars[start] = " ";
    let i = start + 1;
    while (i < chars.length && chars[i] !== q && (q === "`" || chars[i] !== "\n")) {
      if (chars[i] === "\\") {
        if (chars[i] !== "\n") chars[i] = " ";
        if (i + 1 < chars.length && chars[i + 1] !== "\n") chars[i + 1] = " ";
        i += 2;
      } else if (q === "`" && chars[i] === "$" && chars[i + 1] === "{") {
        chars[i] = " "; chars[i + 1] = " "; i += 2;
        for (let d = 1; i < chars.length && d > 0; ) {
          if (isQuoteOpen(chars, i)) i = maskQuoted(i);
          else {
            if (chars[i] === "{") d += 1;
            else if (chars[i] === "}" && --d === 0) { chars[i++] = " "; break; }
            i += 1;
          }
        }
      } else {
        if (chars[i] !== "\n") chars[i] = " ";
        i += 1;
      }
    }
    if (i < chars.length && chars[i] === q) { chars[i] = " "; return i + 1; }
    return i;
  };
  for (let i = 0; i < chars.length; ) i = isQuoteOpen(chars, i) ? maskQuoted(i) : i + 1;
  return chars.join("");
}

/** Scan one script file (`text`, repo-relative `rel`) for design findings. */
export function scanScript(text, rel, settings) {
  ensureDesignContext(settings);
  const findings = [];
  const lines = text.split("\n");
  const clean = blankComments(text);
  const unquoted = blankStrings(clean);
  const lineOf = (offset) => text.slice(0, offset).split("\n").length - 1;
  const report = (rule, offset, message) => {
    const line = lineOf(offset);
    findings.push({ rule, file: rel, line: line + 1, text: lines[line] ?? "", message, where: `${rel}:${line + 1}` });
  };

  const inSystem = Boolean(settings.system && (rel === settings.system || rel.startsWith(`${settings.system}/`)) && !/<[A-Za-z]|\bcreateElement\s*\(|\b_?jsxs?\s*\(/.test(unquoted));
  const inTokens = Boolean(settings.tokens && (rel === settings.tokens || rel.startsWith(`${settings.tokens}/`) || inSystem));
  const inUi = Boolean(settings.ui && (rel === settings.ui || rel.startsWith(`${settings.ui}/`)));
  const inContent = (settings.contentValues ?? []).some((scope) => scope.endsWith("/") ? rel.startsWith(scope) : rel === scope);
  const renderer = rendererValues(clean, (spec) => settings.rendererPackage?.(rel, spec) === true, { content: inContent });

  const stringConsts = new Map();
  for (const m of clean.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:\\.|(?!\2).)*)\2/g)) stringConsts.set(m[1], m[3]);
  const literalConsts = new Set(stringConsts.keys());

  let reanimatedInterpolate = false;
  const rawPrimitives = new Map(), routerLinks = new Set(), routerNamespaces = new Set(), hostComponents = new Set();

  const resolveRelTarget = (spec) => {
    const aliased = settings.aliasTarget?.(rel, spec);
    if (aliased) return aliased.replace(/^\.\//, "");
    if (!spec.startsWith(".")) return null;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const stack = [];
    for (const part of (dir ? `${dir}/${spec}` : spec).split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop(); else stack.push(part);
    }
    return stack.join("/");
  };
  const isLocalImport = (spec) => {
    if (spec.startsWith(".")) return true;
    const pkgName = spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
    return settings.packages?.[pkgName] === settings.ui || settings.packages?.[spec] === settings.ui || Boolean(settings.aliasTarget?.(rel, spec));
  };

  const importRanges = [];
  for (const m of clean.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g)) {
    importRanges.push([m.index, m.index + m[0].length]);
    const clause = m[1].trim(), spec = m[2];
    if (/^type\s+(?:\{|\*|[A-Za-z_$])/.test(clause)) continue;
    const namedMatch = /\{([^}]*)\}/.exec(clause);
    const namedItems = namedMatch
      ? namedMatch[1].split(",").map((p) => p.trim()).filter((p) => p && !/^type\s+/.test(p)).map((p) => {
          const [orig, alias] = p.split(/\s+as\s+/);
          return { orig: orig.trim(), local: (alias ?? orig).trim() };
        })
      : [];
    const nsMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    const defName = clause.split(/[*{]/)[0].replace(/,\s*$/, "").trim();
    if (!inUi && isInteractivePackage(spec)) {
      const onlyReducedMotion = spec === "react-native-reanimated" && !nsMatch && !defName && namedItems.length > 0 && namedItems.every((item) => item.orig === "useReducedMotion");
      if (!onlyReducedMotion) report("design/interactive-import", m.index, `${spec} is imported outside the UI package (${settings.ui})`);
    }
    if (spec === "react-native-reanimated" && namedItems.some((item) => item.orig === "interpolate" && item.local === "interpolate")) reanimatedInterpolate = true;
    if (isPrimitiveSource(spec)) for (const item of namedItems) if (RAW_PRIMITIVES.has(item.orig)) rawPrimitives.set(item.local, item.orig);
    if (isRouterSource(spec)) {
      if (nsMatch) routerNamespaces.add(nsMatch[1]);
      for (const item of namedItems) if (WEB_LINKS.has(item.orig)) routerLinks.add(item.local);
    }
    if (!isLocalImport(spec)) {
      if (/^[A-Za-z_$][\w$]*$/.test(defName)) hostComponents.add(defName);
      if (nsMatch) hostComponents.add(nsMatch[1]);
      for (const item of namedItems) hostComponents.add(item.local);
    } else {
      const target = resolveRelTarget(spec);
      const fromTokens = target && settings.tokens && (target === settings.tokens || target.startsWith(`${settings.tokens}/`));
      if (target && !fromTokens) for (const item of namedItems) literalConsts.add(item.local);
    }
  }

  const localLiteralConsts = new Set(stringConsts.keys()), localInits = [];
  for (const m of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^\n;]+(?:\n\s*[?:+*/|&-][^\n;]+)*)/g)) {
    let init = m[2].trim();
    if (reanimatedInterpolate && /^interpolate\s*\(/.test(init)) {
      const parsed = splitCallArgs(init, init.indexOf("("));
      init = parsed && parsed.args.length >= 3 ? parsed.args[2] : "";
    }
    localInits.push([m[1], init]);
    if (hasNonBinaryNumber(init) !== null || /["']/.test(init)) localLiteralConsts.add(m[1]);
  }
  for (const m of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*\{([\s\S]*?)\}\s*(?:as\s+const\s*)?;/g)) {
    if (hasNonBinaryNumber(m[2]) !== null || /["']/.test(m[2])) literalConsts.add(m[1]);
  }
  for (const m of clean.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(-?(?:0\.[0-9]+|[0-9]+(?:\.[0-9]+)?))\s*[,}]/g)) {
    if (m[2] !== "0" && m[2] !== "1") localLiteralConsts.add(m[1]);
  }
  for (const [name, init] of localInits) {
    if (/^[A-Za-z_$][\w$]*$/.test(init) && (localLiteralConsts.has(init) || literalConsts.has(init))) localLiteralConsts.add(name);
  }
  for (const m of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*[;\n]/g)) {
    const [, lhs, rhs] = m;
    if (rawPrimitives.has(rhs)) rawPrimitives.set(lhs, rawPrimitives.get(rhs));
    if (routerLinks.has(rhs)) routerLinks.add(lhs);
    if (rhs.includes(".")) {
      const [ns, prop] = rhs.split(".");
      if (routerNamespaces.has(ns) && WEB_LINKS.has(prop)) routerLinks.add(lhs);
    }
  }

  const touchAliases = new Set(), touchTargetVars = new Set();
  if (inUi) {
    const calls = [...(settings.touchCalls ?? [])];
    for (const m of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      const [, lhs, rhs] = m;
      const touchesWeb = /["'](button|a|input|select|textarea)["']/.test(rhs);
      const touchesRouter = [...routerLinks].some((l) => new RegExp(`\\b${l}\\b`).test(rhs)) ||
        [...routerNamespaces].some((ns) => new RegExp(`\\b${ns}\\.(Link|NavLink)\\b`).test(rhs));
      if (touchesWeb || touchesRouter) touchAliases.add(lhs);
      if (calls.some((c) => new RegExp(`\\b${c}\\s*\\(`).test(rhs))) touchTargetVars.add(lhs);
    }
  }

  if (!inUi) {
    for (const m of clean.matchAll(/\b(createElement|_?jsxs?|_?jsxDEV)\s*\(\s*["'](button|a|input|select|textarea)["']/g)) {
      report("design/raw-interactive", m.index, `${m[1]}("${m[2]}") is a raw interactive element; use the UI package`);
    }
    if (rawPrimitives.size > 0) {
      for (const m of unquoted.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\b/g)) {
        const ref = m[1];
        if (!rawPrimitives.has(ref.split(".")[0]) || importRanges.some(([s, e]) => m.index >= s && m.index < e)) continue;
        const prev = m.index > 0 ? unquoted[m.index - 1] : " ", prev2 = m.index > 1 ? unquoted.slice(m.index - 2, m.index) : "  ";
        if (prev === "<" || prev2 === "</" || prev === ".") continue;
        if (/(?:\b(?:const|let|var|type|interface)\s+|:\s*)$/.test(unquoted.slice(Math.max(0, m.index - 20), m.index))) continue;
        report("design/raw-interactive", m.index, `${ref} is a raw interactive primitive; use the UI package (${settings.ui})`);
      }
    }
  }

  for (const m of unquoted.matchAll(/<([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\b/g)) {
    const before = m.index > 0 ? unquoted[m.index - 1] : " ", tagName = m[1];
    if (/[A-Za-z0-9_$]/.test(before) && !WEB_ELEMENTS.has(tagName)) continue;
    const attrBase = m.index + m[0].length;
    let i = attrBase, d = 0;
    const topMask = [];
    while (i < clean.length) {
      const ch = clean[i];
      if (isQuoteOpen(clean, i)) {
        const endQ = skipQuoted(clean, i);
        for (let k = i; k <= endQ && k < clean.length; k += 1) topMask.push(d === 0 ? clean[k] : " ");
        i = endQ + 1;
      } else if (ch === "{") { topMask.push(d === 0 ? "{" : " "); d += 1; i += 1; }
      else if (ch === "}") { d = Math.max(0, d - 1); topMask.push(d === 0 ? "}" : " "); i += 1; }
      else if (d === 0 && ch === ">") break;
      else { topMask.push(d === 0 ? ch : " "); i += 1; }
    }
    const attrText = clean.slice(attrBase, i), topAttrText = topMask.join("");
    if (inUi) {
      const isHiddenInput = tagName === "input" && /\btype\s*=\s*["']hidden["']/.test(topAttrText);
      const isRouterTag = routerLinks.has(tagName) || (tagName.includes(".") && routerNamespaces.has(tagName.split(".")[0]) && WEB_LINKS.has(tagName.split(".")[1]));
      const isTouchPrimitive = TOUCH_PRIMITIVES.has(rawPrimitives.get(tagName));
      if ((!isHiddenInput && WEB_ELEMENTS.has(tagName)) || isRouterTag || isTouchPrimitive || touchAliases.has(tagName)) {
        const calls = [...(settings.touchCalls ?? [])];
        const hasSpreadCall = calls.some((c) => new RegExp(`\\{\\s*\\.\\.\\.\\s*${c}\\s*\\(`).test(attrText)) ||
          [...touchTargetVars].some((v) => new RegExp(`\\{\\s*\\.\\.\\.\\s*${v}\\b`).test(attrText));
        if (!hasSpreadCall && !(isTouchPrimitive && /\bhitSlop\b/.test(topAttrText))) {
          const how = calls.length ? `spread ${calls.map((c) => `${c}()`).join(" or ")} or pass its hitSlop`
            : "declare the UI package's touch call in contracts.design.touch_calls and spread it";
          report("design/touch-target", m.index, `<${tagName}> in the UI package has no touch target; ${how}`);
        }
      }
    } else if (rawPrimitives.has(tagName.split(".")[0])) {
      report("design/raw-interactive", m.index, `<${tagName}> is a raw interactive primitive; use the UI package (${settings.ui})`);
    } else if (WEB_ELEMENTS.has(tagName)) {
      report("design/raw-interactive", m.index, `<${tagName}> is a raw interactive element; use the UI package`);
    }
    const isHost = !inUi && !rawPrimitives.has(tagName.split(".")[0]) && !WEB_ELEMENTS.has(tagName) && (/^[a-z]/.test(tagName) || hostComponents.has(tagName.split(".")[0]));
    for (const am of topAttrText.matchAll(/\b([A-Za-z_$][\w$-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|(\{\s*\})))?/g)) {
      const attrName = am[1], attrOffset = attrBase + am.index, strVal = am[2] ?? am[3] ?? null;
      const exprVal = am[4] ? attrText.slice(am.index + am[0].lastIndexOf("{") + 1, am.index + am[0].length - 1) : null;
      if (isHost && isInteractionProp(attrName) && !renderer.lifecycle(tagName, attrName)) report("design/raw-interactive", attrOffset, `${attrName} on <${tagName}>; interaction comes from the UI package (${settings.ui})`);
      if (isHost && (attrName === "role" || attrName === "accessibilityRole") && strVal === "button") report("design/raw-interactive", attrOffset, `${attrName}="button" on <${tagName}>; use a UI package button`);
      if (!inTokens && !inContent && !renderer.attribute(attrOffset) && isColorProperty(attrName) && strVal && isNamedColor(strVal)) report("design/color-literal", attrOffset, `${attrName}: named color "${strVal}"; use a color token from ${settings.tokens}`);
      if (!inTokens && !inContent && !renderer.attribute(attrOffset) && settings.styleProperties.has(attrName)) {
        if (strVal !== null) report("design/style-literal", attrOffset, `${attrName}: literal "${strVal}"; use a token from ${settings.tokens}`);
        else if (exprVal) {
          const num = hasNonBinaryNumber(exprVal);
          const constUse = [...exprVal.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?![\w$:(])/g)].find((cm) => localLiteralConsts.has(cm[1])) ??
            [...exprVal.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?![\w$.:(])/g)].find((cm) => literalConsts.has(cm[1]));
          const why = num !== null ? `literal ${num}` : constUse ? `literal ${constUse[1]}` : null;
          if (why !== null) report("design/style-literal", attrOffset, `${attrName}: ${why}; use a token from ${settings.tokens}`);
        }
      }
      if (attrName === "className" || attrName === "class") {
        for (const cls of arbitraryClasses(strVal ?? exprVal ?? "")) report("design/arbitrary-value", attrOffset, `Tailwind arbitrary value '${cls.trim()}'; use a token class`);
      }
    }
  }

  if (inTokens) return findings;
  if (inContent) return [...findings, ...contentUiFindings(text, rel, settings, {
    rendererPhysical: renderer.physical, rendererLifecycle: renderer.lifecycle,
  })];

  const scanLiteralsInRange = (startIdx, endIdx) => {
    for (let idx = startIdx; idx < endIdx; ) {
      const ch = clean[idx];
      if (!isQuoteOpen(clean, idx)) { idx += 1; continue; }
      const end = skipQuoted(clean, idx);
      const isSpecifier = /\b(?:from\s*|require\s*\(\s*|import\s*\(\s*|(?:vi|jest)\.mock\s*\(\s*)$/.test(clean.slice(Math.max(0, idx - 40), idx));
      if (ch === "`") {
        const staticParts = [];
        for (let cur = idx + 1; cur < end; ) {
          if (clean[cur] === "\\") cur += 2;
          else if (clean.startsWith("${", cur)) {
            staticParts.push(` ${SUBSTITUTION} `);
            const subStart = cur + 2;
            let curSub = subStart;
            for (let d = 1; curSub < end && d > 0; ) {
              if (isQuoteOpen(clean, curSub)) curSub = skipQuoted(clean, curSub) + 1;
              else { if (clean[curSub] === "{") d += 1; else if (clean[curSub] === "}") d -= 1; curSub += 1; }
            }
            scanLiteralsInRange(subStart, curSub - 1);
            cur = curSub;
          } else staticParts.push(text[cur++]);
        }
        const combined = staticParts.join("");
        if (!isSpecifier) {
          if (!renderer.literal(idx) && hasScriptColorSyntax(combined)) report("design/color-literal", idx, `color literal in a template; use a color token from ${settings.tokens}`);
          if (/<style\b|\sstyle\s*=\s*["']/i.test(combined)) scanEmbeddedCss(combined, settings, (rule, _off, msg) => { if (rule !== "design/color-literal") report(rule, idx, msg); });
        }
      } else if (!isSpecifier) {
        const rawLiteral = text.slice(idx + 1, end);
        if (!renderer.literal(idx) && hasScriptColorSyntax(rawLiteral)) report("design/color-literal", idx, `color literal ${JSON.stringify(rawLiteral.slice(0, 40))}; use a color token from ${settings.tokens}`);
        if (/<style\b|\sstyle\s*=\s*["']/i.test(rawLiteral)) scanEmbeddedCss(rawLiteral, settings, (rule, _off, msg) => { if (rule !== "design/color-literal") report(rule, idx, msg); });
      }
      idx = end + 1;
    }
  };
  scanLiteralsInRange(0, clean.length);

  for (const m of clean.matchAll(/\[\s*["'](--[A-Za-z0-9_-]+)["'][^\]]*\]\s*:\s*([^,}\n]+)/g)) {
    const prop = m[1], rhs = m[2].trim();
    const quoted = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(rhs);
    const strVal = quoted ? quoted[2] : stringConsts.get(rhs) ?? null;
    if ((strVal !== null && !isTokenReference(strVal)) || (strVal === null && hasNonBinaryNumber(rhs) !== null)) {
      report("design/token-outside-module", m.index, `${prop} defines a token by hand; author it in ${settings.tokens}`);
    }
  }

  const styleLiteralWhy = (expr) => {
    if (/^(?:number|string|boolean)\s*=/.test(expr)) return null;
    const num = hasNonBinaryNumber(expr);
    if (num !== null) return `literal ${num}`;
    if (!/\s\|\s/.test(expr)) {
      const strMatch = /(?<!\[)\s*(["'])((?:\\.|(?!\1).)*)\1/.exec(expr);
      if (strMatch) return `literal "${strMatch[2]}"`;
    }
    for (const m of expr.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?![\w$:(])/g)) if (localLiteralConsts.has(m[1])) return `literal ${m[1]}`;
    for (const m of expr.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?![\w$.:(])/g)) if (literalConsts.has(m[1])) return `literal ${m[1]}`;
    return null;
  };

  for (const m of clean.matchAll(/(?<=[{,]\s*)([A-Za-z_$][\w$]*)\s*:\s*/g)) {
    const prop = m[1];
    if (!settings.styleProperties.has(prop) || renderer.property(m.index)) continue;
    const valStart = m.index + m[0].length;
    let i = valStart;
    for (let d = 0; i < clean.length; ) {
      const ch = clean[i];
      if (isQuoteOpen(clean, i)) i = skipQuoted(clean, i) + 1;
      else if (ch === "(" || ch === "[" || ch === "{") { d += 1; i += 1; }
      else if (ch === ")" || ch === "]" || ch === "}") { if (d === 0) break; d -= 1; i += 1; }
      else if (d === 0 && (ch === "," || ch === ";" || ch === "\n")) break;
      else i += 1;
    }
    let rhs = clean.slice(valStart, i).trim();
    if (reanimatedInterpolate && /^interpolate\s*\(/.test(rhs)) {
      const parsed = splitCallArgs(rhs, rhs.indexOf("("));
      rhs = parsed && parsed.args.length >= 3 ? parsed.args[2] : "";
    } else if (/\.interpolate\s*\(\s*\{/.test(rhs)) {
      const outMatch = /\boutputRange\s*:\s*(\[[^\]]*\])/.exec(rhs);
      rhs = outMatch ? outMatch[1] : "";
    }
    const why = styleLiteralWhy(rhs);
    if (why !== null) report("design/style-literal", m.index, `${prop}: ${why}; use a token from ${settings.tokens}`);
  }
  return findings;
}
