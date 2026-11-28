// Physical scene values are not UI theme values.
// Recognize the receiving API, not a module name or a whole callback/argument.
import { rendererTokens, rendererScalar } from "./pb_design_renderer_lex.mjs";
import { rendererBindings } from "./pb_design_renderer_bindings.mjs";

const MATERIALS = new Set([
  "Material",
  "MeshBasicMaterial",
  "MeshStandardMaterial",
  "MeshPhysicalMaterial",
  "MeshLambertMaterial",
  "MeshPhongMaterial",
  "MeshToonMaterial",
  "MeshNormalMaterial",
  "MeshDepthMaterial",
  "MeshDistanceMaterial",
  "MeshMatcapMaterial",
  "ShadowMaterial",
  "SpriteMaterial",
  "PointsMaterial",
  "LineBasicMaterial",
  "LineDashedMaterial",
  "ShaderMaterial",
  "RawShaderMaterial",
]);
const LIGHTS = new Set([
  "AmbientLight",
  "DirectionalLight",
  "HemisphereLight",
  "PointLight",
  "RectAreaLight",
  "SpotLight",
  "LightProbe",
]);
const COLORS = new Set([
  "color",
  "emissive",
  "specular",
  "sheenColor",
  "attenuationColor",
  "groundColor",
]);
const MATERIAL_VALUES = new Set([
  ...COLORS,
  "opacity",
  "alphaTest",
  "metalness",
  "roughness",
  "emissiveIntensity",
  "shininess",
  "reflectivity",
  "refractionRatio",
  "ior",
  "clearcoat",
  "clearcoatRoughness",
  "sheen",
  "sheenRoughness",
  "transmission",
  "thickness",
  "attenuationDistance",
  "envMapIntensity",
  "aoMapIntensity",
  "lightMapIntensity",
  "bumpScale",
  "displacementScale",
  "displacementBias",
  "normalScale",
  "size",
  "linewidth",
  "dashSize",
  "gapSize",
  "scale",
]);
const TRANSFORMS = new Set(["position", "rotation", "scale", "quaternion"]);
const LIGHT_VALUES = new Set([
  ...COLORS,
  "intensity",
  "distance",
  "decay",
  "angle",
  "penumbra",
  "power",
  "width",
  "height",
]);
const OBJECTS = new Set([
  "mesh",
  "group",
  "object3D",
  "scene",
  "instancedMesh",
  "skinnedMesh",
  "points",
  "sprite",
  "bone",
  "perspectiveCamera",
  "orthographicCamera",
  "cubeCamera",
  "lod",
]);
// SVG's <line> is intentionally absent: an import cannot change a DOM host.
const GEOMETRIES = new Set([
  "boxGeometry",
  "sphereGeometry",
  "planeGeometry",
  "circleGeometry",
  "cylinderGeometry",
  "coneGeometry",
  "torusGeometry",
  "torusKnotGeometry",
  "capsuleGeometry",
  "ringGeometry",
  "dodecahedronGeometry",
  "icosahedronGeometry",
  "octahedronGeometry",
  "tetrahedronGeometry",
  "bufferGeometry",
  "extrudeGeometry",
  "shapeGeometry",
  "latheGeometry",
  "tubeGeometry",
]);
const decap = (name) => name[0].toLowerCase() + name.slice(1);
const MATERIAL_TAGS = new Set([...MATERIALS].map(decap));
const LIGHT_TAGS = new Set([...LIGHTS].map(decap));
const COLOR_METHODS = new Set(["set", "setStyle", "setHex", "setRGB", "setHSL"]);
const NONE = Object.freeze(
  Object.fromEntries(
    ["literal", "property", "attribute", "physical", "host", "lifecycle"].map((key) => [
      key,
      () => false,
    ]),
  ),
);

export function rendererValues(source, packageIsGenuine, { content = false } = {}) {
  // Reviewed scene sources may use globally registered Fiber intrinsics without
  // importing an otherwise unused renderer. Ordinary files still need a binding.
  const contentHost =
    content && (packageIsGenuine("three") || packageIsGenuine("@react-three/fiber"));
  if (!contentHost && !/\bfrom\s*["'](?:three|@react-three\/fiber)["']/.test(source)) return NONE;
  const index = rendererTokens(source),
    { tokens: ts, pairs, split } = index;
  const bindings = rendererBindings(index, (spec) => !packageIsGenuine(spec));
  if (!contentHost && !bindings.hasRenderer) return NONE;
  const literals = new Set(),
    properties = new Set(),
    attributes = new Set();
  const instances = new Map(),
    constructors = new Map();
  const val = (i) => ts[i]?.value;
  const scalar = (start, end) => {
    const leaves = rendererScalar(index, start, end);
    if (leaves === null) return false;
    for (const t of leaves) {
      const s = t.value.slice(1, -1);
      if (
        /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(s) ||
        /^(?:rgb|hsl)a?\([\d\s.,%+/-]+\)$/i.test(s)
      )
        literals.add(t.start);
    }
    return true;
  };
  const materialObject = (start, end) => {
    if (val(start) !== "{" || pairs.get(start) !== end - 1) return;
    for (const [a, b] of split(start + 1, end - 1)) {
      if (ts[a]?.kind !== "name" || val(a + 1) !== ":" || !MATERIAL_VALUES.has(val(a))) continue;
      if (scalar(a + 2, b)) properties.add(ts[a].start);
    }
  };
  // Constructors: only known Three exports. Their nested callbacks/JSX are never
  // excluded, and material objects contribute only recognized physical fields.
  for (let i = 0; i < ts.length; i++) {
    if (val(i) !== "new") continue;
    const ref = bindings.reference(i + 1);
    if (ref?.source !== "three" || val(ref.end) !== "(" || !pairs.has(ref.end)) continue;
    const kind = ref.exported,
      end = pairs.get(ref.end);
    if (
      !["Color", "Fog", "FogExp2", "WebGLRenderer"].includes(kind) &&
      !MATERIALS.has(kind) &&
      !LIGHTS.has(kind)
    )
      continue;
    constructors.set(i, { kind, end: end + 1 });
    const args = split(ref.end + 1, end);
    if (MATERIALS.has(kind)) {
      if (args[0]) materialObject(...args[0]);
    } else if (kind !== "WebGLRenderer") {
      const count = kind === "HemisphereLight" ? 2 : kind === "Color" ? args.length : 1;
      for (const arg of args.slice(0, count)) scalar(...arg);
    }
    if (
      val(i - 1) === "=" &&
      ts[i - 2]?.kind === "name" &&
      val(i - 3) === "const" &&
      [";", ",", undefined].includes(val(end + 1))
    ) {
      const name = val(i - 2);
      if (instances.has(name)) instances.get(name).invalid = true;
      else instances.set(name, { kind, declaration: i - 2 });
    }
  }
  // Local instance receivers must remain immutable and unshadowed. Unknown
  // helper/data flow does not gain renderer provenance through a suggestive name.
  for (let i = 0; i < ts.length; i++) {
    const instance = instances.get(val(i));
    if (instance && instance.declaration !== i && val(i + 1) !== ".") instance.invalid = true;
    if (instance && instance.declaration !== i) {
      let member = i + 1;
      while (val(member) === "." && ts[member + 1]?.kind === "name") member += 2;
      if (["=", "+=", "-=", "++", "--"].includes(val(member))) instance.invalid = true;
    }
  }
  for (let i = 0; i < ts.length; i++) {
    const instance = instances.get(val(i));
    let kind, member;
    if (instance && !instance.invalid) {
      kind = instance.kind;
      member = i + 1;
    } else if (constructors.has(i)) {
      const made = constructors.get(i);
      kind = made.kind;
      member = made.end;
    } else continue;
    if (val(member) !== ".") continue;
    if (
      (MATERIALS.has(kind) || LIGHTS.has(kind)) &&
      COLORS.has(val(member + 1)) &&
      val(member + 2) === "."
    ) {
      kind = "Color";
      member += 2;
    }
    const method = val(member + 1),
      open = member + 2;
    if (val(open) !== "(" || !pairs.has(open)) continue;
    const args = split(open + 1, pairs.get(open));
    if (kind === "Color" && COLOR_METHODS.has(method)) for (const arg of args) scalar(...arg);
    if (kind === "WebGLRenderer" && method === "setClearColor" && args[0]) scalar(...args[0]);
    if (MATERIALS.has(kind) && method === "setValues" && args[0]) materialObject(...args[0]);
  }
  const host = (tag) =>
    (contentHost || bindings.hasRenderer) &&
    (OBJECTS.has(tag) ||
      GEOMETRIES.has(tag) ||
      MATERIAL_TAGS.has(tag) ||
      LIGHT_TAGS.has(tag) ||
      ["color", "fog", "fogExp2"].includes(tag));
  const physical = (tag, attr) => {
    if (!host(tag)) return false;
    if (attr === "args") return true;
    if (MATERIAL_TAGS.has(tag)) return MATERIAL_VALUES.has(attr);
    if (LIGHT_TAGS.has(tag)) return TRANSFORMS.has(attr) || LIGHT_VALUES.has(attr);
    if (OBJECTS.has(tag)) return TRANSFORMS.has(attr);
    return false;
  };
  // Parse only attribute values; do not skip to the end of a JSX expression.
  // A second pass through the script still visits every DOM child and callback.
  for (let i = 0; i < ts.length; i++) {
    if (val(i) !== "<" || ts[i + 1]?.kind !== "name") continue;
    let tag = val(i + 1),
      cursor = i + 2;
    while (val(cursor) === "." && ts[cursor + 1]?.kind === "name") {
      tag += `.${val(cursor + 1)}`;
      cursor += 2;
    }
    if (!host(tag)) continue;
    while (cursor < ts.length && ![">", "/"].includes(val(cursor))) {
      const attr = cursor++;
      if (val(attr) === "{" && pairs.has(attr)) {
        cursor = pairs.get(attr) + 1;
        continue;
      }
      if (ts[attr]?.kind !== "name" || val(cursor) !== "=") continue;
      cursor++;
      let start = cursor,
        end = cursor + 1;
      if (val(cursor) === "{" && pairs.has(cursor)) {
        start++;
        end = pairs.get(cursor);
        cursor = end + 1;
      } else cursor++;
      if (!physical(tag, val(attr))) continue;
      if (scalar(start, end)) attributes.add(ts[attr].start);
      else if (
        val(attr) === "args" &&
        MATERIAL_TAGS.has(tag) &&
        val(start) === "[" &&
        pairs.get(start) === end - 1
      ) {
        const args = split(start + 1, end - 1);
        if (args[0]) materialObject(...args[0]);
      }
    }
  }
  return {
    literal: (offset) => literals.has(offset),
    property: (offset) => properties.has(offset),
    attribute: (offset) => attributes.has(offset),
    physical,
    host,
    lifecycle: (tag, attr) => {
      if (attr === "onCreated") {
        const ref = bindings.qualified(tag);
        return ref?.source === "@react-three/fiber" && ref.exported === "Canvas";
      }
      return (
        host(tag) && (attr === "onUpdate" || (attr === "onBeforeCompile" && MATERIAL_TAGS.has(tag)))
      );
    },
  };
}
