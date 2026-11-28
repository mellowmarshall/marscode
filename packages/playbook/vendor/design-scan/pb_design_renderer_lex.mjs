// Small lexical index for renderer value recognition.
// This is not a JavaScript evaluator: unsupported syntax remains design-checked.
export function rendererTokens(source) {
  const tokens = [], pairs = new Map(), stack = [];
  const quotedEnd = (start) => {
    const quote = source[start]; let p = start + 1;
    while (p < source.length && source[p] !== quote) {
      if (source[p] === '\\') p += 2;
      else if (quote === '`' && source.startsWith('${', p)) {
        p += 2;
        for (let depth = 1; p < source.length && depth > 0;) {
          if ('"\'`'.includes(source[p])) p = quotedEnd(p);
          else { if (source[p] === '{') depth++; else if (source[p] === '}') depth--; p++; }
        }
      } else p++;
    }
    return p < source.length ? p + 1 : p;
  };
  for (let p = 0; p < source.length;) {
    const start = p, ch = source[p];
    if (/\s/.test(ch)) { p++; continue; }
    if (source.startsWith('//', p)) { p = source.indexOf('\n', p); if (p < 0) break; continue; }
    if (source.startsWith('/*', p)) { const end = source.indexOf('*/', p + 2); p = end < 0 ? source.length : end + 2; continue; }
    let kind = 'punct';
    if ('"\'`'.includes(ch)) {
      kind = 'string'; p = quotedEnd(p);
    } else if (ch === '/' && (!tokens.length || ['=', '(', '[', ',', ':', 'return', '=>', '!', '&&', '||', '?', ';'].includes(tokens.at(-1).value))) {
      // Regex source is data, not imports or a renderer call.
      kind = 'regex'; p++; let inClass = false;
      while (p < source.length && source[p] !== '\n') {
        if (source[p] === '\\') p += 2;
        else if (source[p] === '/' && !inClass) { p++; break; }
        else { if (source[p] === '[') inClass = true; else if (source[p] === ']') inClass = false; p++; }
      }
      while (p < source.length && /[a-z]/i.test(source[p])) p++;
    } else if (/[A-Za-z_$]/.test(ch)) {
      kind = 'name'; while (p < source.length && /[\w$]/.test(source[p])) p++;
    } else if (/[0-9]/.test(ch)) {
      kind = 'number'; while (p < source.length && /[\w.]/.test(source[p])) p++;
    } else {
      const compound = ['=>', '===', '!==', '...', '?.', '==', '!=', '&&', '||', '??', '++', '--', '+=', '-=', '*=', '/='].find((s) => source.startsWith(s, p));
      p += compound?.length ?? 1;
    }
    const i = tokens.length, value = source.slice(start, p);
    tokens.push({ value, kind, start, end: p, depth: stack.length });
    if (kind === 'punct' && '([{'.includes(value)) stack.push(i);
    else if (kind === 'punct' && ')]}'.includes(value)) {
      const open = stack.pop();
      if (open !== undefined && '([{'.indexOf(tokens[open].value) === ')]}'.indexOf(value)) { pairs.set(open, i); pairs.set(i, open); }
    }
  }
  const split = (start, end, separator = ',') => {
    const parts = []; let from = start;
    for (let i = start; i < end; i++) {
      if (tokens[i].value === separator) { parts.push([from, i]); from = i + 1; }
      else if (pairs.get(i) > i) i = pairs.get(i);
    }
    if (from < end) parts.push([from, end]);
    return parts;
  };
  return { tokens, pairs, split };
}

/** Return scalar/array leaves only; calls, objects, JSX and functions fail closed. */
export function rendererScalar(index, start, end) {
  const { tokens, pairs } = index, leaves = [];
  if (start >= end) return null;
  const allowed = new Set(['.', '?.', '?', ':', '+', '-', '*', '/', '%', '!', '~', '&', '|', '^', '&&', '||', '??', '===', '!==', '==', '!=', ',']);
  for (let i = start; i < end; i++) {
    const t = tokens[i], prev = tokens[i - 1];
    if (t.kind === 'string') {
      // A template substitution can contain DOM or callbacks. Do not hide it.
      if (t.value.startsWith('`') && t.value.includes('${')) return null;
      if (i > start && (prev.kind === 'name' || [')', ']'].includes(prev.value))) return null;
      leaves.push(t); continue;
    }
    if (t.kind === 'number' || t.kind === 'name') {
      if (['function', 'class', 'new', 'return', 'yield', 'await', 'delete'].includes(t.value)) return null;
      continue;
    }
    if (t.value === '(' || t.value === '[') {
      if (pairs.get(i) === undefined || pairs.get(i) >= end) return null;
      if (i > start && (prev.kind === 'name' || [')', ']', '.', '?.'].includes(prev.value))) return null;
      continue;
    }
    if (t.value === ')' || t.value === ']') continue;
    if (!allowed.has(t.value)) return null;
  }
  return leaves;
}
