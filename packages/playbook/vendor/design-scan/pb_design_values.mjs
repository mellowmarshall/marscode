// Vendored verbatim from the original playbook's design scan; only comments differ.
/**
 * What counts as a color or a style literal, for the design rules
 * (playbook section 10). Shared by the script rules (designScript.mjs) and the
 * stylesheet rules (designStylesheet.mjs).
 *
 * A color is any of: a hex value (#rgb, #rgba, #rrggbb, #rrggbbaa), a color
 * function (rgb, rgba, hsl, hsla, hwb, lab, lch, oklab, oklch, color-mix,
 * color(<space> ...)), or a CSS named color. A hex value or a color function
 * is a color wherever it appears; a named color only where a color is
 * expected (a color property or attribute), since "gold" or "silver" are also
 * ordinary words.
 *
 * In a stylesheet, a Tailwind v4 CSS function of an exact allowed shape is
 * a token too (isThemeCall): `--spacing(2)`, `--value(number)`,
 * `--modifier([length])`, `--theme(--x)`, `--alpha(var(--x) / 50%)`. Any other
 * argument (`--spacing(13px)`, `--theme(--x, #fff)`) and a literal beside a
 * call (`calc(--spacing(2) + 3px)`) are literals.
 *
 * Three shapes look like colors and are not (and the channel token):
 * - a color-mix() whose every color is a token (`var(--x)` with no fallback,
 *   a value a script substitutes, or transparent/currentColor): it derives a
 *   token, as `color-mix(in srgb, var(--ink) 40%, transparent)` tints one.
 *   One literal color among its arguments makes the whole mix a literal.
 * - an rgb(), rgba(), hsl() or hsla() whose only color argument is a token
 *   holding the channels (`hsl(var(--border))`, `hsl(var(--primary) / 0.2)`,
 *   `rgba(var(--ink), 0.5)`; an alpha that is a number, a percentage or a
 *   token): it reads a token, the way a theme stores `--border: 214 32% 91%`.
 *   A channel written as a number makes it a literal.
 * - in a script's prose, an issue or ticket reference: `#` and three or four
 *   decimal digits with no leading zero ("post #9021", "(#799)"), when a
 *   capitalized word stands right before it or the text runs three words in a
 *   row. A stylesheet never reads that way, so stylesheets keep every hex.
 */

// Delimited so "#123abc" inside a URL fragment or an id counts only when it stands alone.
const HEX = /(^|[\s(,:'"`=])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?=$|[\s),;'"`!])/;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(|\bcolor\(\s*(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65)\b/i;

export const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
    "mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace " +
    "olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
    "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue " +
    "saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey " +
    "snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen"
  ).split(" ")
);

/** A property or attribute that takes a color: color, fill, stroke, tint, *Color, *-color, background. */
export function isColorProperty(name) {
  return /(^|[a-z-])colou?r$/i.test(name) || /^(fill|stroke|background|tint|stop-?color)$/i.test(name) || /Colou?r$/.test(name);
}

// What a script puts in a color-mix() slot; the scan writes a substitution as this.
export const SUBSTITUTION = "var(--x)";
const TOKEN_COLOR = /^(?:var\(\s*--[A-Za-z0-9_-]+\s*\)|transparent|currentcolor)$/i;
// An unresolved part of a folded string (pb_design_script writes NUL for it).
const UNRESOLVED = String.fromCharCode(0);
const MIX_INTERPOLATION = /^in\s+[a-z0-9-]+(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?$/i;
const MIX_WEIGHT = /\s+(?:calc\([^()]*\)|-?[0-9.]+%)$|^(?:calc\([^()]*\)|-?[0-9.]+%)\s+/i;

/** The top-level comma-separated arguments of the call whose "(" is at `open`, and the index after its ")"; null when unbalanced. */
function callArguments(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth === 0) return { args: [...args, text.slice(start, i).trim()], end: i + 1 };
    else if (ch === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** A color-mix() argument list whose every color is a token (or a mix of tokens). */
function isTokenMix(args) {
  if (args.length !== 3 || !MIX_INTERPOLATION.test(args[0])) return false;
  return args.slice(1).every((arg) => {
    const color = arg.replace(MIX_WEIGHT, "").trim();
    if (color === UNRESOLVED || TOKEN_COLOR.test(color)) return true;
    const nested = /^color-mix\s*\(/i.exec(color);
    const inner = nested && callArguments(color, nested[0].length - 1);
    return Boolean(inner && inner.end === color.length && isTokenMix(inner.args));
  });
}

const CHANNEL_TOKEN = /^var\(\s*--[A-Za-z0-9_-]+\s*\)$/i;
const TOKEN_ALPHA = /^(?:-?[0-9.]+%?|var\(\s*--[A-Za-z0-9_-]+\s*\))$/i;

/**
 * An rgb()/rgba()/hsl()/hsla() argument list that is one channel token, with an
 * optional alpha: `hsl(var(--x) / 0.2)`; the comma form only for rgba()/hsla(),
 * where the second argument is the alpha (`hsl(var(--x), 50%)` is a channel).
 */
function isTokenChannels(name, args) {
  if (args.length === 2) return /a$/i.test(name) && CHANNEL_TOKEN.test(args[0]) && TOKEN_ALPHA.test(args[1]);
  if (args.length !== 1) return false;
  const [color, alpha, extra] = args[0].split("/").map((part) => part.trim());
  return extra === undefined && CHANNEL_TOKEN.test(color) && (alpha === undefined || TOKEN_ALPHA.test(alpha));
}

/** `text` with each color-mix() of tokens, and each color function of one channel token, blanked: what is left is judged for literal colors. */
export function withoutTokenMixes(text) {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(/\b(color-mix|rgba?|hsla?)\s*\(/gi)) {
    if (match.index < at) continue;
    const call = callArguments(text, match.index + match[0].length - 1);
    const token = /^color-mix$/i.test(match[1]) ? call && isTokenMix(call.args) : call && isTokenChannels(match[1], call.args);
    if (!token) continue;
    out += `${text.slice(at, match.index)} `;
    at = call.end;
  }
  return out + text.slice(at);
}

/** True when `text` holds a hex value or a color function (a color-mix of tokens is neither). */
export function hasColorSyntax(text) {
  const judged = withoutTokenMixes(text);
  return HEX.test(judged) || COLOR_FUNCTION.test(judged);
}

const HEX_ALL = new RegExp(HEX.source, "g");
const REFERENCE = /^[1-9][0-9]{2,3}$/;

/**
 * hasColorSyntax for the text of a script string: the same, except that an
 * issue reference in prose ("Proof #8491", "before #2843 the") is not a hex.
 */
export function hasScriptColorSyntax(text) {
  const judged = withoutTokenMixes(text);
  if (COLOR_FUNCTION.test(judged)) return true;
  for (const match of judged.matchAll(HEX_ALL)) {
    const digits = match[0].slice(match[0].indexOf("#") + 1);
    const before = judged.slice(0, match.index + match[1].length).trimEnd().split(/\s+/).pop() ?? "";
    // A style value: the hex follows `property:` (CSS) or sits in a style= attribute; a colon elsewhere in prose is not one.
    const lead = judged.slice(0, match.index + match[1].length);
    const styled = /[a-z-]+\s*:\s*$/i.test(lead) || /style\s*=/i.test(judged);
    const referenceWord = /^\(?(issue|issues|post|posts|pr|prs|pull|ticket|bug|fixes|closes)$/i.test(before);
    const parenthesized = new RegExp(`\\(#${digits}\\)`).test(judged);
    if (REFERENCE.test(digits) && !styled && (referenceWord || parenthesized)) continue;
    return true;
  }
  return false;
}

/** True when `text`, taken whole, is a named color. */
export function isNamedColor(text) {
  return NAMED_COLORS.has(text.trim().toLowerCase());
}

/** CSS property (kebab) to the camel name the closed list uses. */
export function camelProperty(name) {
  return name.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Values a closed-list property may take besides a token: none is a literal size, weight or family.
const CSS_KEYWORDS = new Set(["0", "1", "inherit", "initial", "unset", "revert", "revert-layer", "auto", "none", "normal"]);

/**
 * True when a stylesheet value for a closed-list property is made only of
 * tokens (`var(--x)`, a color-mix() of them, a color function of one channel
 * token, or a Tailwind v4 theme function), 0, 1 and CSS-wide keywords.
 * `calc(var(--a) * 2)` carries a literal 2 and fails.
 */
// Tailwind v4's CSS functions: an allow-list of exact shapes.
const THEME_FUNCTION = /(?<![\w-])--(spacing|value|modifier|theme|alpha)\s*\(/gi;
const VALUE_TYPE = /^(?:number|integer|percentage|ratio|\[[a-z*-]+\])$/;

/** `text` is exactly one token shape: var(--x), a channel token color, or an allowed theme function call. */
function isTokenShape(text) {
  if (CHANNEL_TOKEN.test(text)) return true;
  const match = /^(rgba?|hsla?|--spacing|--value|--modifier|--theme|--alpha)\s*\(/i.exec(text);
  const call = match && callArguments(text, match[0].length - 1);
  if (!call || call.end !== text.length) return false;
  return match[1].startsWith("--") ? isThemeCall(match[1].slice(2).toLowerCase(), call.args) : isTokenChannels(match[1], call.args);
}

/**
 * --spacing(<unitless number>, --value(number) or --value(integer)); --value() and
 * --modifier(<type keyword or [type]>); --theme(--name or --name-*, with a
 * fallback only of a token shape); --alpha(<token shape> / <number or %>).
 */
function isThemeCall(name, args) {
  if (name === "spacing") return args.length === 1 && /^(?:[0-9]*\.?[0-9]+|--value\((?:number|integer)\))$/.test(args[0]);
  if (name === "value" || name === "modifier") return args.length === 1 && VALUE_TYPE.test(args[0]);
  if (name === "theme") return /^--[A-Za-z0-9_-]+(?:-\*)?$/.test(args[0]) && args.length <= 2 && args.slice(1).every(isTokenShape);
  const [color, amount, extra] = args.length === 1 ? args[0].split("/").map((part) => part.trim()) : [];
  return extra === undefined && /^[0-9.]+%?$/.test(amount ?? "") && isTokenShape(color ?? "");
}

/** `value` with each well-formed Tailwind v4 theme function call blanked; a call with a literal argument stays. */
function withoutThemeFunctions(value) {
  let out = "";
  let at = 0;
  for (const match of value.matchAll(THEME_FUNCTION)) {
    if (match.index < at) continue;
    const call = callArguments(value, match.index + match[0].length - 1);
    if (!call || !isThemeCall(match[1].toLowerCase(), call.args)) continue;
    out += `${value.slice(at, match.index)} `;
    at = call.end;
  }
  return out + value.slice(at);
}

export function isTokenCssValue(value) {
  const stripped = withoutTokenMixes(withoutThemeFunctions(value))
    .replace(/!important\s*$/i, "")
    .replace(/var\(\s*--[A-Za-z0-9_-]+\s*\)/g, " ")
    .replace(/\b(?:calc|min|max|clamp)\(/gi, " ")
    .replace(/[(),*+/]/g, " ")
    .trim();
  if (!stripped) return true;
  return stripped.split(/\s+/).every((word) => CSS_KEYWORDS.has(word.toLowerCase()));
}

/**
 * A custom property's value outside the token module that only reads tokens:
 * a token value with no digit left once the token shapes are taken out, or a
 * lone 0 or 1. `calc(1/0) 0 0` is a token value but sets channels by hand.
 */
export function isTokenReference(value) {
  if (/^[01]$/.test(value.trim())) return true;
  const left = withoutTokenMixes(withoutThemeFunctions(value)).replace(/var\(\s*--[A-Za-z0-9_-]+\s*\)/g, " ");
  return isTokenCssValue(value) && !/[0-9]/.test(left);
}

/** The named colors standing as whole words in a CSS value (not inside var(--name) or url()). */
export function namedColorsInCss(value) {
  const plain = value.replace(/var\([^)]*\)/g, " ").replace(/url\([^)]*\)/g, " ").replace(/(["']).*?\1/g, " ");
  return (plain.match(/(?<![\w-])[a-zA-Z]+(?![\w-])/g) ?? []).filter((word) => NAMED_COLORS.has(word.toLowerCase()));
}

// A bracket group with no space (a class list writes a space as `_`); one level of nested brackets, as in `[&_[data-x]]`.
const GROUP = String.raw`\[(?:[^\[\]\s]|\[[^\[\]\s]*\])*\]`;
// Variants in front of a utility: `md:`, `max-md:`, `group-hover/item:`, `data-[state=open]:`, `[&>p]:`, `has-[:checked]:`.
const VARIANTS = String.raw`(?:(?:[\w@*/.-]|${GROUP})+:)*`;
// An arbitrary property, the other spelling of an arbitrary value: `[padding:3px]`, `md:![opacity:0.5]`, `[--k:0_100%_50%]`.
// The `!` goes in front of the class or after its variants (or trails it, where the match ends before it); the bracket ends the class,
// or an opacity modifier follows it (`[--k:1]/50`), which is not part of the finding.
const PROPERTY_CLASS = String.raw`!?${VARIANTS}!?\[(?:--[\w-]+|-?[a-z][a-z0-9-]*):(?:[^\[\]\s]|\[[^\[\]\s]*\])+\](?![\w:.\[-])`;
const VALUE_CLASS = String.raw`!?[a-z][a-z0-9:-]*-\[[^\]\s]+\]`;
const ARBITRARY_CLASS = new RegExp(String.raw`(?:^|\s)(?:${PROPERTY_CLASS}|${VALUE_CLASS})`, "g");

/**
 * Tailwind arbitrary values (`w-[312px]`, `bg-[#fff]`) and arbitrary properties
 * (`[padding:3px]`, `[--k:0_100%_50%]`) in a class list. Any value is one: a
 * token inside the brackets is no allowance, as `p-[var(--x)]` is found today.
 */
export function arbitraryClasses(classList) {
  return classList.match(ARBITRARY_CLASS) ?? [];
}
