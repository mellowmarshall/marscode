// HTML embedded in declared physical content is still ordinary UI.
import { scanEmbeddedCss, scanStylesheet } from "./pb_design_sheet.mjs";
import {
  arbitraryClasses,
  camelProperty,
  hasColorSyntax,
  isColorProperty,
  isNamedColor,
  isTokenCssValue,
} from "./pb_design_values.mjs";

/** Findings use positions within the supplied HTML; callers map them to their container. */
export function contentHtmlFindings(text, rel, settings) {
  const findings = scanStylesheet(text, `${rel}.html`, settings).map((item) => ({
    ...item,
    file: rel,
    where: `${rel}:${item.line}`,
  }));
  const inUi = settings.ui && (rel === settings.ui || rel.startsWith(`${settings.ui}/`));
  const report = (rule, offset, message) => {
    const line = text.slice(0, offset).split("\n").length;
    findings.push({
      rule,
      file: rel,
      line,
      text: text.split("\n")[line - 1] ?? "",
      message,
      where: `${rel}:${line}`,
    });
  };
  for (const tag of text.matchAll(/<([a-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const name = tag[1].toLowerCase();
    if (!inUi && /^(?:button|a|input|select|textarea)$/.test(name))
      report(
        "design/raw-interactive",
        tag.index,
        `<${name}> is a raw interactive element; use the UI package`,
      );
    for (const attr of tag[2].matchAll(
      /([A-Za-z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    )) {
      const prop = attr[1].toLowerCase(),
        value = attr[2] ?? attr[3] ?? attr[4];
      const offset = tag.index + 1 + tag[1].length + attr.index;
      if (
        !inUi &&
        /^on(?:click|dblclick|pointer\w*|mouse\w*|key\w*|touch\w*|input|change|submit|focus|blur)$/i.test(
          prop,
        )
      )
        report(
          "design/raw-interactive",
          offset,
          `${prop} on <${name}>; interaction comes from the UI package (${settings.ui})`,
        );
      if (/__CONTENT_VALUE_\d+__/i.test(prop))
        report("design/content-ui-unresolved", offset, "unresolved attributes in embedded HTML");
      if (value === undefined) continue;
      if (
        (["class", "style"].includes(prop) ||
          isColorProperty(prop) ||
          settings.styleProperties.has(camelProperty(prop))) &&
        /__CONTENT_VALUE_\d+__/.test(value)
      )
        report(
          "design/content-ui-unresolved",
          offset,
          `${prop}: unresolved value in embedded HTML`,
        );
      if (prop === "style") {
        if (attr[4] !== undefined)
          scanEmbeddedCss(
            value,
            settings,
            (rule, at, message) => report(rule, offset + at, message),
            { declarationsOnly: true },
          );
        continue;
      }
      if (prop === "class") {
        if (attr[4] !== undefined)
          for (const cls of arbitraryClasses(value))
            report(
              "design/arbitrary-value",
              offset,
              `Tailwind arbitrary value '${cls.trim()}'; use a token class`,
            );
        continue;
      }
      if (isColorProperty(prop) && (hasColorSyntax(value) || isNamedColor(value)))
        report(
          "design/color-literal",
          offset,
          `${prop}: color literal in HTML; use a token from ${settings.tokens}`,
        );
      if (settings.styleProperties.has(camelProperty(prop)) && !isTokenCssValue(value))
        report(
          "design/style-literal",
          offset,
          `${prop}: literal in HTML; use a token from ${settings.tokens}`,
        );
    }
  }
  return findings;
}
