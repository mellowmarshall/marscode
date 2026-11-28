// From the original playbook's design scan; only comments and the node: import style differ.
// Content may author scene values. Its original UI sinks still use design tokens.
import { contentAst } from "./pb_design_content_ast.mjs";
import { contentHtmlFindings } from "./pb_design_content_html.mjs";
import { contentNumbers } from "./pb_design_content_numbers.mjs";
import { scanEmbeddedCss, scanStylesheet } from "./pb_design_sheet.mjs";
import {
  arbitraryClasses,
  camelProperty,
  hasColorSyntax,
  isColorProperty,
  isNamedColor,
  isTokenCssValue,
  isTokenReference,
} from "./pb_design_values.mjs";

const PASSIVE = new Set(
  "onLayout onTextLayout onContentSizeChange onLoad onLoadStart onLoadEnd onLoadedData onLoadedMetadata onError onMountError onProgress onEnded onPlaybackStatusUpdate onFirstFrameRender onDisplay onCameraReady onBarcodeScanned onAnimationStart onAnimationEnd onAnimationIteration onTransitionStart onTransitionEnd onScroll onScrollToIndexFailed onViewableItemsChanged onEndReached onEndReachedThreshold".split(
    " ",
  ),
);
const INTERACTIVE = /^(?:button|a|input|select|textarea)$/;
const interaction = (name) => /^on[A-Z]\w*$/.test(name) && !PASSIVE.has(name);

/** Called only for a declared content file; renderer predicates require proven package bindings. */
export function contentUiFindings(text, rel, settings, renderer = {}) {
  const findings = [],
    seen = new Set(),
    lines = text.split("\n");
  const reportAt = (rule, offset, message) => {
    const line = text.slice(0, offset).split("\n").length;
    const key = `${rule}:${offset}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      rule,
      file: rel,
      line,
      text: lines[line - 1] ?? "",
      message,
      where: `${rel}:${line}`,
    });
  };
  let ast;
  try {
    ast = contentAst(text, rel, settings);
  } catch (error) {
    reportAt("design/content-ui-unresolved", 0, /** @type {Error} */ (error).message);
    return findings;
  }
  const { ts, source, unwrap, resolve, token, nameOf, binding, componentKind } = ast;
  const numbers = contentNumbers(ast);
  let sink;
  const report = (rule, node, message) =>
    reportAt(
      rule,
      node?.getSourceFile() === source ? node.getStart(source) : (sink?.getStart(source) ?? 0),
      message,
    );
  const unknown = (node, sink) =>
    report(
      "design/content-ui-unresolved",
      node,
      `${sink}: cannot establish a token-based UI value in declared content; use an explicit token or local style object`,
    );
  const inUi = settings.ui && (rel === settings.ui || rel.startsWith(`${settings.ui}/`));
  const physical = (tag, prop) => renderer.rendererPhysical?.(tag, prop) ?? false;
  const lifecycle = (tag, prop) => renderer.rendererLifecycle?.(tag, prop) ?? false;
  const isEmpty = (node) =>
    !node ||
    [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.TrueKeyword].includes(
      node.kind,
    ) ||
    (ts.isIdentifier(node) && node.text === "undefined" && !binding(node));
  const choices = (node, visit) => {
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return true;
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) visit(node.left);
      visit(node.right);
      return true;
    }
    return false;
  };
  const staticText = (original, visited = new Set()) => {
    const node = resolve(original);
    if (!node || visited.has(node)) return null;
    visited = new Set([...visited, node]);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(node.left, visited),
        right = staticText(node.right, visited);
      if (left !== null && right !== null) return left + right;
    }
    return null;
  };
  const literal = (value, prop, node, mode) => {
    if (mode === "class") {
      for (const cls of arbitraryClasses(value))
        report(
          "design/arbitrary-value",
          node,
          `Tailwind arbitrary value '${cls.trim()}'; use a token class`,
        );
      return;
    }
    if (hasColorSyntax(value) || (isColorProperty(prop) && isNamedColor(value)))
      report(
        "design/color-literal",
        node,
        `${prop}: color literal; use a color token from ${settings.tokens}`,
      );
    if (prop.startsWith("--") && !isTokenReference(value))
      report(
        "design/token-outside-module",
        node,
        `${prop} defines a token by hand; author it in ${settings.tokens}`,
      );
    else if (settings.styleProperties.has(prop) && !isTokenCssValue(value))
      report(
        "design/style-literal",
        node,
        `${prop}: literal ${JSON.stringify(value.slice(0, 40))}; use a token from ${settings.tokens}`,
      );
  };
  const checkValue = (original, prop, mode = "value", visited = new Set()) => {
    if (!prop.startsWith("--")) prop = camelProperty(prop);
    if (!original || isEmpty(unwrap(original))) return;
    if (token(original)) return;
    const node = resolve(original);
    if (!node || visited.has(node)) {
      if (
        mode === "class" ||
        prop.startsWith("--") ||
        isColorProperty(prop) ||
        settings.styleProperties.has(prop)
      )
        unknown(original, prop);
      return;
    }
    visited = new Set([...visited, node]);
    const recur = (value) => checkValue(value, prop, mode, visited);
    if (isEmpty(node) || choices(node, recur)) return;
    if (prop.startsWith("--") && numbers.runtime(node)) return;
    const constant = numbers.constant(node);
    if (constant !== undefined && (ts.isCallExpression(node) || ts.isBinaryExpression(node))) {
      literal(String(constant), prop, node, mode);
      return;
    }
    if (ts.isStringLiteralLike(node)) {
      literal(node.text, prop, node, mode);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const folded = staticText(node);
      if (folded !== null) {
        literal(folded, prop, node, mode);
        return;
      }
    }
    if (
      ts.isNumericLiteral(node) ||
      (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
    ) {
      const value = node.getText();
      if (
        mode === "class" ||
        isColorProperty(prop) ||
        (settings.styleProperties.has(prop) && !/^[01]$/.test(value))
      )
        report(
          "design/style-literal",
          original,
          `${prop}: literal ${value}; use a token from ${settings.tokens}`,
        );
      else if (prop.startsWith("--") && !/^[01]$/.test(value))
        report(
          "design/token-outside-module",
          original,
          `${prop} defines a token by hand; author it in ${settings.tokens}`,
        );
      return;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        recur(span.expression);
        value += `var(--content-token)${span.literal.text}`;
      }
      literal(value, prop, node, mode);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) recur(item);
      return;
    }
    if (mode === "class" && ts.isObjectLiteralExpression(node)) {
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) recur(item.expression);
        else if (nameOf(item.name) !== null) literal(nameOf(item.name), prop, item, mode);
        else unknown(item, prop);
      }
      return;
    }
    if (mode === "class" && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const entry = binding(node.expression);
      if (
        entry &&
        !entry.changed &&
        ["clsx", "classnames", "tailwind-merge"].includes(entry.spec)
      ) {
        for (const arg of node.arguments) recur(arg);
        return;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
      ].includes(node.operatorToken.kind)
    ) {
      recur(node.left);
      recur(node.right);
      return;
    }
    if (
      mode === "class" ||
      prop.startsWith("--") ||
      isColorProperty(prop) ||
      settings.styleProperties.has(prop)
    )
      unknown(original, prop);
  };
  const checkStyle = (original, visited = new Set()) => {
    if (isEmpty(unwrap(original)) || token(original)) return;
    const node = resolve(original);
    if (!node || visited.has(node)) {
      unknown(original, "style");
      return;
    }
    visited = new Set([...visited, node]);
    const recur = (value) => checkStyle(value, visited);
    if (isEmpty(node) || choices(node, recur)) return;
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) recur(item);
      return;
    }
    if (ts.isArrowFunction(node)) {
      if (!ts.isBlock(node.body)) recur(node.body);
      else {
        let returned = false;
        const returns = (item) => {
          if (ts.isFunctionLike(item)) return;
          if (ts.isReturnStatement(item)) {
            returned = true;
            recur(item.expression);
          } else ts.forEachChild(item, returns);
        };
        returns(node.body);
        if (!returned) unknown(node, "style callback");
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) {
      unknown(original, "style");
      return;
    }
    for (const item of node.properties) {
      if (ts.isSpreadAssignment(item)) {
        recur(item.expression);
        continue;
      }
      const prop = nameOf(item.name);
      if (prop === null) {
        unknown(item, "computed style property");
        continue;
      }
      if (ts.isPropertyAssignment(item)) checkValue(item.initializer, prop);
      else if (ts.isShorthandPropertyAssignment(item)) checkValue(item.name, prop);
      else unknown(item, prop);
    }
  };
  const checkProp = (prop, value, at, tag, kind, fromSpread = false) => {
    sink = at;
    if (prop === "style" || /Style$/.test(prop)) {
      checkStyle(value);
      return;
    }
    if (prop === "className" || prop === "class") {
      checkValue(value, prop, "class");
      return;
    }
    if (!inUi && fromSpread && interaction(prop) && !lifecycle(tag, prop))
      report(
        "design/raw-interactive",
        at,
        `${prop} on <${tag}>; interaction comes from the UI package (${settings.ui})`,
      );
    if (physical(tag, prop)) return;
    if (kind !== "content" && (isColorProperty(prop) || settings.styleProperties.has(prop)))
      checkValue(value, prop);
    if (prop === "dangerouslySetInnerHTML") checkMarkup(value, true);
  };
  const checkProps = (original, tag, kind, visited = new Set()) => {
    if (isEmpty(unwrap(original))) return;
    const node = resolve(original);
    if (!node || visited.has(node)) {
      if (kind !== "content") unknown(original, `props on <${tag}>`);
      return;
    }
    visited = new Set([...visited, node]);
    if (choices(node, (value) => checkProps(value, tag, kind, visited))) return;
    if (ts.isArrayLiteralExpression(node)) {
      for (const item of node.elements) checkProps(item, tag, kind, visited);
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) {
      if (kind !== "content") unknown(original, `props on <${tag}>`);
      return;
    }
    for (const item of node.properties) {
      if (ts.isSpreadAssignment(item)) {
        checkProps(item.expression, tag, kind, visited);
        continue;
      }
      const prop = nameOf(item.name);
      if (prop === null) {
        unknown(item, `computed prop on <${tag}>`);
        continue;
      }
      const value = ts.isPropertyAssignment(item)
        ? item.initializer
        : ts.isShorthandPropertyAssignment(item)
          ? item.name
          : null;
      checkProp(prop, value, item, tag, kind, true);
    }
  };
  const markupText = (node) => {
    if (ts.isStringLiteralLike(node)) return { value: node.text, substitutions: [] };
    const folded = ts.isBinaryExpression(node) ? staticText(node) : null;
    if (folded !== null) return { value: folded, substitutions: [] };
    if (!ts.isTemplateExpression(node)) return null;
    let value = node.head.text;
    const substitutions = node.templateSpans.map((span, index) => {
      const marker = `__CONTENT_VALUE_${index}__`;
      value += marker + span.literal.text;
      return { marker, expression: span.expression };
    });
    return { value, substitutions };
  };
  const scanMarkup = (node, { css = false, declarationsOnly = false } = {}) => {
    const markup = markupText(node);
    if (!markup) return false;
    const { value, substitutions } = markup;
    const regions =
      css || declarationsOnly
        ? [value]
        : [
            ...value.matchAll(
              /<style\b[^>]*>([\s\S]*?)<\/style>|\s(?:style|class)\s*=\s*(["'])([\s\S]*?)\2/gi,
            ),
          ].map((match) => match[1] ?? match[3]);
    for (const sub of substitutions)
      if (regions.some((region) => region.includes(sub.marker)) && !token(sub.expression))
        unknown(sub.expression, "embedded UI style or class");
    const folded = substitutions.reduce(
      (out, sub) =>
        out.replace(sub.marker, token(sub.expression) ? "var(--content-token)" : sub.marker),
      value,
    );
    if (css)
      for (const item of scanStylesheet(folded, `${rel}.css`, settings))
        report(item.rule, node, item.message);
    else if (declarationsOnly)
      scanEmbeddedCss(folded, settings, (rule, _offset, message) => report(rule, node, message), {
        declarationsOnly,
      });
    else
      for (const item of contentHtmlFindings(folded, rel, settings))
        report(item.rule, node, item.message);
    return true;
  };
  const checkMarkup = (original, htmlObject = false) => {
    const node = resolve(original);
    if (htmlObject && node && ts.isObjectLiteralExpression(node)) {
      for (const item of node.properties) {
        if (nameOf(item.name) === "__html" && ts.isPropertyAssignment(item))
          checkMarkup(item.initializer);
        else unknown(item, "dangerouslySetInnerHTML");
      }
    } else if (!node || !scanMarkup(node)) unknown(original, "HTML markup");
  };
  const memberName = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    const value = ts.isElementAccessExpression(node) && resolve(node.argumentExpression);
    return value && ts.isStringLiteralLike(value) ? value.text : null;
  };
  const isStyle = (node, visited = new Set()) => {
    node = unwrap(node);
    if (!node || visited.has(node)) return false;
    if (memberName(node) === "style") return true;
    const entry = ts.isIdentifier(node) && binding(node);
    return Boolean(
      entry &&
      (entry.keys?.at(-1) === "style" ||
        (entry.initializer && isStyle(entry.initializer, new Set([...visited, node])))),
    );
  };
  const threeAttribute = (node) => {
    node = resolve(node);
    if (!node || !ts.isNewExpression(node) || settings.rendererPackage?.(rel, "three") !== true)
      return false;
    const target = node.expression;
    const root = ts.isPropertyAccessExpression(target) ? target.expression : target;
    const entry = ts.isIdentifier(root) && binding(root);
    const kind = ts.isPropertyAccessExpression(target) ? target.name.text : entry?.imported;
    return (
      entry?.spec === "three" &&
      /^(?:Instanced|Interleaved|Float16|Float32|Int8|Int16|Int32|Uint8|Uint8Clamped|Uint16|Uint32)?BufferAttribute$/.test(
        kind ?? "",
      )
    );
  };
  const threeGeometry = (node) => {
    node = resolve(node);
    if (!node || !ts.isNewExpression(node) || settings.rendererPackage?.(rel, "three") !== true)
      return false;
    const target = node.expression,
      root = ts.isPropertyAccessExpression(target) ? target.expression : target;
    const entry = ts.isIdentifier(root) && binding(root);
    const kind = ts.isPropertyAccessExpression(target) ? target.name.text : entry?.imported;
    return entry?.spec === "three" && kind === "BufferGeometry";
  };
  const checkCssText = (original) => {
    const node = resolve(original);
    if (!node || !scanMarkup(node, { declarationsOnly: true })) unknown(original, "CSS text");
  };
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source),
        kind = componentKind(node.tagName);
      for (const prop of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(prop)) checkProps(prop.expression, tag, kind);
        else {
          const value =
            prop.initializer && ts.isJsxExpression(prop.initializer)
              ? prop.initializer.expression
              : prop.initializer;
          checkProp(prop.name.getText(source), value, prop, tag, kind);
        }
      }
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateExpression(node) ||
      ts.isBinaryExpression(node)
    )
      scanMarkup(node);
    if (
      ts.isTaggedTemplateExpression(node) &&
      /^(?:css|createGlobalStyle|styled(?:\.|\())/.test(node.tag.getText(source))
    )
      scanMarkup(node.template, { css: true });
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      sink = node;
      const left = unwrap(node.left),
        name = memberName(left);
      if (name === "style") checkStyle(node.right);
      else if (name === "innerHTML" || name === "outerHTML") checkMarkup(node.right);
      else if (name === "className") checkValue(node.right, name, "class");
      else if (name && isStyle(left.expression)) {
        if (name === "cssText") checkCssText(node.right);
        else checkValue(node.right, name);
      } else if (ts.isElementAccessExpression(left) && isStyle(left.expression))
        unknown(left, "computed CSS property");
    }
    if (ts.isCallExpression(node)) {
      sink = node;
      const name =
        memberName(node.expression) ??
        (ts.isIdentifier(node.expression) ? node.expression.text : "");
      if (/^(?:createElement|_?jsxs?|_?jsxDEV)$/.test(name) && node.arguments.length >= 2) {
        const tagNode = node.arguments[0],
          tag = ts.isStringLiteralLike(tagNode) ? tagNode.text : tagNode.getText(source);
        const kind = ts.isStringLiteralLike(tagNode) ? "dom" : componentKind(tagNode);
        checkProps(node.arguments[1], tag, kind);
        if (!inUi && INTERACTIVE.test(tag))
          report(
            "design/raw-interactive",
            node,
            `${name}("${tag}") is a raw interactive element; use the UI package`,
          );
      }
      if (
        name === "setAttribute" &&
        ts.isStringLiteralLike(node.arguments[0] ?? {}) &&
        node.arguments[1] &&
        !threeAttribute(node.arguments[1]) &&
        !threeGeometry(node.expression.expression)
      ) {
        const prop = node.arguments[0].text;
        if (prop === "style") checkCssText(node.arguments[1]);
        else if (prop === "class") checkValue(node.arguments[1], prop, "class");
        else if (isColorProperty(prop) || settings.styleProperties.has(prop))
          checkValue(node.arguments[1], prop);
      }
      if (name === "setProperty" && isStyle(node.expression.expression) && node.arguments[1]) {
        const value = resolve(node.arguments[0]);
        const prop = value && ts.isStringLiteralLike(value) ? value.text : null;
        if (prop === null) unknown(node, "computed CSS property");
        else checkValue(node.arguments[1], prop);
      }
      if (
        name === "assign" &&
        node.expression.expression?.getText(source) === "Object" &&
        isStyle(node.arguments[0])
      )
        for (const arg of node.arguments.slice(1)) checkStyle(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
