// Vendored verbatim from the original playbook's design scan; only comments differ.
/**
 * The design rules over stylesheets: .css files, the <style> blocks and
 * style="" / class="" attributes of .html files, and CSS a script writes
 * (embedded blocks, style="" in HTML strings, styles set at run time)
 * (playbook section 10).
 *
 *   design/color-literal        a color value (hex, color function, named color)
 *   design/style-literal        a closed-list property whose value is not made
 *                               of var(--token), 0, 1 and CSS-wide keywords
 *   design/token-outside-module a custom property defined with a literal value:
 *                               tokens are authored in the token module and
 *                               generated into stylesheets, so a hand-written
 *                               `--pad: 12px` would launder a literal
 *   design/arbitrary-value      a Tailwind arbitrary value (`p-[3px]`) or arbitrary
 *                               property (`[padding:3px]`) in a class attribute
 */
import { contentHtmlFindings } from "./pb_design_content_html.mjs";
import { ensureDesignContext } from "./pb_design_renderer_package.mjs";
import { arbitraryClasses, camelProperty, hasColorSyntax, isTokenCssValue, isTokenReference, namedColorsInCss } from "./pb_design_values.mjs";

/** Findings for one stylesheet or HTML file. */
export function scanStylesheet(text, rel, settings) {
  const findings = [];
  const lines = text.split("\n");
  const report = (rule, offset, message) => {
    const line = text.slice(0, offset).split("\n").length - 1;
    findings.push({ rule, file: rel, line: line + 1, text: lines[line] ?? "", message, where: `${rel}:${line + 1}` });
  };
  if (rel.endsWith(".css")) scanCss(text, 0, settings, report);
  else {
    for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      scanCss(match[1], match.index + match[0].indexOf(match[1]), settings, report);
    }
    for (const match of text.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
      scanDeclarations(match[2], match.index + match[0].indexOf(match[2]), settings, report);
    }
    for (const match of text.matchAll(/\sclass\s*=\s*(["'])([\s\S]*?)\1/gi)) {
      for (const cls of arbitraryClasses(match[2])) report("design/arbitrary-value", match.index, `Tailwind arbitrary value '${cls.trim()}'; use a token class`);
    }
  }
  return findings;
}

/** Comments blanked with spaces so offsets stay true. */
const blankComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));

/**
 * CSS inside a script: a tagged template (css`...`, styled.x`...`,
 * createGlobalStyle`...`) or a string carrying a <style> block. `report(rule,
 * offset, message)` is the script's reporter; offsets are within `text`.
 */
export function scanEmbeddedCss(text, settings, report, { declarationsOnly = false } = {}) {
  if (declarationsOnly) {
    scanDeclarations(blankComments(text), 0, settings, report);
    return;
  }
  for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    scanCss(match[1], match.index + match[0].indexOf(match[1]), settings, report);
  }
  // HTML built in a script (infra/web/functions renders pages as strings).
  for (const match of text.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    scanDeclarations(match[2], match.index + match[0].indexOf(match[2]), settings, report);
  }
}

/** Authored JSON values are content, but embedded HTML/CSS remains UI. */
function contentDataFindings(text, rel, settings) {
  const findings = [];
  try { JSON.parse(text); }
  catch { return [{ rule: "design/content-data", file: rel, line: 1, text: text.split("\n")[0], message: "content data is not valid JSON" }]; }
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    const value = JSON.parse(match[0]);
    if (!/<[A-Za-z][\w:-]*\b/.test(value)) continue;
    const line = text.slice(0, match.index).split("\n").length;
    for (const finding of contentHtmlFindings(value, rel, settings)) {
      findings.push({ ...finding, line, text: text.split("\n")[line - 1], where: `${rel}:${line}` });
    }
  }
  return findings;
}

/** A JSON file in client code: color values, and closed-list keys holding anything but 0 or 1. */
export function scanJson(text, rel, settings) {
  ensureDesignContext(settings);
  if ((settings.contentValues ?? []).some((scope) => (scope.endsWith("/") ? rel.startsWith(scope) : rel === scope))) {
    return contentDataFindings(text, rel, settings);
  }
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const at = { file: rel, line: index + 1, text: line, where: `${rel}:${index + 1}` };
    for (const match of line.matchAll(/"([^"\\]*)"/g)) {
      if (hasColorSyntax(match[1])) findings.push({ ...at, rule: "design/color-literal", message: `color literal "${match[1].slice(0, 40)}"; use a token from ${settings.tokens}` });
    }
    const keyed = /"([A-Za-z]+)"\s*:\s*("[^"]*"|-?[0-9.]+)/.exec(line);
    if (keyed && settings.styleProperties.has(keyed[1]) && !/^[01]$/.test(keyed[2])) {
      findings.push({ ...at, rule: "design/style-literal", message: `${keyed[1]}: ${keyed[2]}; use a token from ${settings.tokens}` });
    }
  });
  return findings;
}

function scanCss(css, base, settings, report) {
  const clean = blankComments(css);
  // A native CSS function can shadow a Tailwind v4 function the rules read as a token.
  for (const match of clean.matchAll(/@function\s+--[\w-]*/g)) {
    report("design/token-outside-module", base + match.index, `${match[0]} defines a function by hand; author it in ${settings.tokens}`);
  }
  // Declarations live between { and }; at-rule preludes (@media (max-width: 700px)) are not declarations.
  for (const match of clean.matchAll(/\{([^{}]*)\}/g)) {
    scanDeclarations(match[1], base + match.index + 1, settings, report);
  }
}

function scanDeclarations(block, base, settings, report) {
  let offset = 0;
  for (const raw of block.split(";")) {
    const at = base + offset;
    offset += raw.length + 1;
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const property = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    const lead = at + (raw.length - raw.trimStart().length);
    // An escaped property name (`\2d\2d x`, `colo\72`) hides what it sets.
    if (property.includes("\\")) report("design/style-literal", lead, `${property.slice(0, 40)}: an escaped property name; write it plainly`);
    if (!property || !value || /[^A-Za-z0-9_-]/.test(property)) continue;
    if (hasColorSyntax(value) || namedColorsInCss(value).length) {
      const named = namedColorsInCss(value);
      report("design/color-literal", lead, `${property}: ${named.length && !hasColorSyntax(value) ? `named color ${named[0]}` : "color literal"}; use a token from ${settings.tokens}`);
    }
    if (property.startsWith("--") || property.toLowerCase() === "initial-value") {
      // The same test as a closed-list value: var(--token) with no literal
      // fallback, 0, 1 and keywords; calc() over a literal launders nothing,
      // nor do digits (`calc(1/0) 0 0` sets channels). An @property's
      // initial-value defines its token too.
      if (!isTokenReference(value) && !hasColorSyntax(value) && !namedColorsInCss(value).length) {
        report("design/token-outside-module", lead, `${property} defines a token by hand; author it in ${settings.tokens} and generate it`);
      }
      continue;
    }
    if (settings.styleProperties.has(camelProperty(property)) && !isTokenCssValue(value)) {
      report("design/style-literal", lead, `${property}: ${value.slice(0, 40)}; use var(--token) from ${settings.tokens}`);
    }
  }
}
