// Import provenance for renderer calls and JSX.
// A binding with an unsupported use is deliberately not trusted. In particular,
// parameters, destructuring, reassignment and local declarations cannot shadow it.
export function rendererBindings(index, isLocalImport) {
  const { tokens: ts, pairs, split } = index;
  const bindings = new Map(),
    importTokens = new Set(),
    aliasRefs = new Set();
  const val = (i) => ts[i]?.value;
  for (let i = 0; i < ts.length; i++) {
    if (val(i) !== "import" || ts[i].depth !== 0 || ["(", "type", "."].includes(val(i + 1)))
      continue;
    if (i > 0 && val(i - 1) !== ";" && ts[i - 1]?.kind !== "string") continue;
    let from = i + 1;
    while (from < ts.length && !["from", ";"].includes(val(from))) from++;
    if (val(from) !== "from" || ts[from + 1]?.kind !== "string") continue;
    const source = val(from + 1).slice(1, -1);
    if (!["three", "@react-three/fiber"].includes(source) || isLocalImport(source)) continue;
    for (let n = i; n <= from + 1; n++) importTokens.add(n);
    const add = (name, exported, at) => {
      if (bindings.has(name)) bindings.get(name).invalid = true;
      else bindings.set(name, { source, exported, declaration: at });
    };
    if (val(i + 1) === "*" && val(i + 2) === "as") add(val(i + 3), "*", i + 3);
    const open = ts.findIndex((t, n) => n > i && n < from && t.value === "{");
    if (open >= 0 && pairs.get(open) < from) {
      for (const [start, end] of split(open + 1, pairs.get(open))) {
        if (val(start) === "type" || ts[start]?.kind !== "name") continue;
        const at = val(start + 1) === "as" ? start + 2 : start;
        if (at + 1 === end) add(val(at), val(start), at);
      }
    }
    i = from + 1;
  }
  const reference = (start, end = ts.length) => {
    const binding = bindings.get(val(start));
    if (!binding || binding.invalid) return null;
    if (binding.exported === "*") {
      if (val(start + 1) !== "." || start + 2 >= end || ts[start + 2]?.kind !== "name") return null;
      return { ...binding, exported: val(start + 2), end: start + 3 };
    }
    return { ...binding, end: start + 1 };
  };
  // Only immutable, direct aliases retain provenance. No destructuring/helper flow.
  for (let i = 0; i < ts.length; i++) {
    if (val(i) !== "const" || ts[i + 1]?.kind !== "name" || val(i + 2) !== "=") continue;
    const ref = reference(i + 3);
    if (!ref || ![";", ",", undefined].includes(val(ref.end))) continue;
    if (bindings.has(val(i + 1))) {
      bindings.get(val(i + 1)).invalid = true;
      continue;
    }
    aliasRefs.add(i + 3);
    bindings.set(val(i + 1), { ...ref, declaration: i + 1, parent: val(i + 3) });
  }
  for (let i = 0; i < ts.length; i++) {
    const b = bindings.get(val(i));
    if (!b || importTokens.has(i) || b.declaration === i || aliasRefs.has(i)) continue;
    const prev = val(i - 1),
      next = val(i + 1);
    const jsx = prev === "<" || (prev === "/" && val(i - 2) === "<");
    // A namespace must be a member receiver. Named imports must be constructors,
    // JSX tags, or calls (hooks); declarations and parameter positions match none.
    const allowed = b.exported === "*" ? next === "." : prev === "new" || jsx || next === "(";
    if (
      !allowed ||
      ["function", "class"].includes(prev) ||
      ["=", "+=", "-=", "++", "--"].includes(next)
    )
      b.invalid = true;
    let member = i + 1;
    while (val(member) === "." && ts[member + 1]?.kind === "name") member += 2;
    if (["=", "+=", "-=", "++", "--"].includes(val(member))) b.invalid = true;
  }
  for (const b of bindings.values()) {
    let parent = b.parent,
      seen = new Set();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const dependency = bindings.get(parent);
      if (!dependency || dependency.invalid) {
        b.invalid = true;
        break;
      }
      parent = dependency.parent;
    }
  }
  const qualified = (name) => {
    const [root, property, extra] = name.split("."),
      b = bindings.get(root);
    if (!b || b.invalid || extra || (property && b.exported !== "*")) return null;
    return { ...b, exported: property ?? b.exported };
  };
  return {
    reference,
    qualified,
    hasRenderer: [...bindings.values()].some((b) => !b.invalid),
    importTokens,
  };
}
