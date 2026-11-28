// Numeric serialization of live CSS custom variables, not authored token values.
const MATH = new Set("abs acos acosh asin asinh atan atanh atan2 cbrt ceil clz32 cos cosh exp expm1 floor fround hypot imul log log1p log2 log10 max min pow round sign sin sinh sqrt tan tanh trunc".split(" "));

export function contentNumbers({ ts, resolve, binding }) {
  const operation = (kind, left, right) => {
    switch (kind) {
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return left / right;
      case ts.SyntaxKind.PercentToken: return left % right;
      case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
      default: return undefined;
    }
  };
  const global = (node, name) => ts.isIdentifier(node) && node.text === name && !binding(node);
  const numericCall = (node) => {
    if (!ts.isCallExpression(node)) return null;
    if (global(node.expression, "Number")) return Number;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && global(callee.expression, "Math") && MATH.has(callee.name.text)) return Math[callee.name.text];
    return null;
  };
  const constant = (original, visited = new Set()) => {
    const node = resolve(original);
    if (!node || visited.has(node)) return undefined;
    visited = new Set([...visited, node]);
    const value = (part) => constant(part, visited);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return node.kind === ts.SyntaxKind.TrueKeyword;
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
      const number = value(node.operand);
      if (number !== undefined) return node.operator === ts.SyntaxKind.MinusToken ? -number : +number;
    }
    if (ts.isBinaryExpression(node)) {
      const left = value(node.left), right = value(node.right);
      if (left !== undefined && right !== undefined) return operation(node.operatorToken.kind, left, right);
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) { const part = value(span.expression); if (part === undefined) return undefined; text += String(part) + span.literal.text; }
      return text;
    }
    if (ts.isPropertyAccessExpression(node) && global(node.expression, "Math") && typeof Math[node.name.text] === "number") return Math[node.name.text];
    const call = numericCall(node) ?? (ts.isCallExpression(node) && global(node.expression, "String") ? String : null);
    if (call) {
      const args = node.arguments.map(value);
      if (args.every((arg) => arg !== undefined)) return call(...args);
    }
    return undefined;
  };
  const numeric = (original, visited = new Set()) => {
    const node = resolve(original);
    if (!node || visited.has(node)) return false;
    visited = new Set([...visited, node]);
    if (typeof constant(node) === "number") return true;
    if (numericCall(node)) return true;
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) return true;
    if (ts.isBinaryExpression(node)) {
      if ([ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken].includes(node.operatorToken.kind)) return true;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return numeric(node.left, visited) && numeric(node.right, visited);
    }
    return false;
  };
  const runtime = (original) => {
    const node = resolve(original);
    if (!node || constant(node) !== undefined) return false;
    if (numeric(node)) return true;
    if (ts.isCallExpression(node) && global(node.expression, "String") && node.arguments.length === 1) return numeric(node.arguments[0]);
    return ts.isTemplateExpression(node) && node.head.text === "" && node.templateSpans.length === 1 &&
      /^(?:px|em|rem|%|vh|vw|vmin|vmax|deg|rad|turn|s|ms)?$/.test(node.templateSpans[0].literal.text) && numeric(node.templateSpans[0].expression);
  };
  return { constant, runtime };
}
