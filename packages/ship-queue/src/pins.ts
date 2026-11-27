// @effect-diagnostics nodeBuiltinImport:off - CI host tool pins spec (`sq_pins.json`) validator, extractor, digest calculator, and Renovate manager builder.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const WRITERS = new Set(["case", "words", "fleet", "none"]);
const SUMS = new Set(["list", "sidecar", "github-digest", "npm"]);
const SOURCES = new Set(["value", "json", "sums-name", "file"]);
const FPR_RE = /^[0-9A-F]{40}$/;
const PIN_FIELDS = new Set([
  "name",
  "file",
  "lines",
  "datasource",
  "depName",
  "match",
  "extractVersion",
  "versioning",
  "allowedVersions",
  "major",
  "monthEnd",
  "derived",
  "assets",
  "sums",
  "writer",
  "signature",
  "floor",
  "no_floor",
  "shared_check",
]);
const SPEC_TOP_FIELDS = new Set(["schema", "note", "pins", "unmanaged", "keys", "unsigned"]);

export interface PinKeySet {
  readonly url: string;
  readonly fingerprints: ReadonlyArray<string>;
  readonly why: string;
}

export interface PinSignature {
  readonly keys: string;
  readonly over: "list" | "asset";
  readonly suffix: string;
}

export interface PinSpecEntry {
  readonly name: string;
  readonly file: string;
  readonly lines: ReadonlyArray<string>;
  readonly datasource: string;
  readonly depName: string;
  readonly match: string;
  readonly extractVersion?: string | undefined;
  readonly versioning?: string | undefined;
  readonly allowedVersions?: string | undefined;
  readonly major?: boolean | undefined;
  readonly monthEnd?: boolean | undefined;
  readonly derived?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly assets: Readonly<Record<string, string>>;
  readonly sums: Readonly<Record<string, unknown>>;
  readonly writer: Readonly<Record<string, unknown>>;
  readonly signature?: PinSignature | undefined;
  readonly floor?: Readonly<Record<string, unknown>> | undefined;
  readonly no_floor?: string | undefined;
  readonly shared_check?: boolean | undefined;
}

export interface PinsSpec {
  readonly schema: 1;
  readonly note?: string | undefined;
  readonly pins: ReadonlyArray<PinSpecEntry>;
  readonly unmanaged?:
    | ReadonlyArray<{ readonly file: string; readonly line: string; readonly why: string }>
    | undefined;
  readonly keys?: Readonly<Record<string, PinKeySet>> | undefined;
  readonly unsigned?: Readonly<Record<string, string>> | undefined;
}

export interface ExtractedPinVersion {
  readonly name: string;
  readonly file: string;
  readonly depName: string;
  readonly currentValue: string;
}

export interface RenovateCustomManager {
  readonly customType: "regex";
  readonly managerFilePatterns: ReadonlyArray<string>;
  readonly matchStrings: ReadonlyArray<string>;
  readonly datasourceTemplate: string;
  readonly depNameTemplate: string;
  readonly extractVersionTemplate?: string | undefined;
  readonly versioningTemplate?: string | undefined;
}

/** Validates a parsed `sq_pins.json` object against schema v1. */
export function validatePinsSpec(raw: unknown, sourceLabel = "sq_pins.json"): PinsSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: not a schema 1 pin spec`);
  }
  const spec = raw as Record<string, unknown>;
  if (spec.schema !== 1 || !Array.isArray(spec.pins)) {
    throw new Error(`${sourceLabel}: not a schema 1 pin spec`);
  }
  for (const k of Object.keys(spec)) {
    if (!SPEC_TOP_FIELDS.has(k)) {
      throw new Error(`${sourceLabel}: unknown top-level field ${JSON.stringify(k)}`);
    }
  }

  const keys =
    spec.keys && typeof spec.keys === "object" && !Array.isArray(spec.keys)
      ? (spec.keys as Record<string, unknown>)
      : {};
  for (const [keyName, ksRaw] of Object.entries(keys)) {
    if (!ksRaw || typeof ksRaw !== "object" || Array.isArray(ksRaw)) {
      throw new Error(`${sourceLabel}: key set ${keyName} is invalid`);
    }
    const ks = ksRaw as Record<string, unknown>;
    const ksKeys = Object.keys(ks).toSorted();
    if (
      ksKeys.join(",") !== "fingerprints,url,why" ||
      typeof ks.url !== "string" ||
      !ks.url.includes("{fpr}") ||
      !Array.isArray(ks.fingerprints) ||
      ks.fingerprints.length === 0 ||
      !ks.fingerprints.every((f) => typeof f === "string" && FPR_RE.test(f)) ||
      typeof ks.why !== "string"
    ) {
      throw new Error(
        `${sourceLabel}: key set ${keyName} must define url (with {fpr}), fingerprints (40 uppercase hex), and why`,
      );
    }
  }

  const unsigned =
    spec.unsigned && typeof spec.unsigned === "object" && !Array.isArray(spec.unsigned)
      ? (spec.unsigned as Record<string, unknown>)
      : {};

  if (spec.unmanaged !== undefined) {
    if (!Array.isArray(spec.unmanaged)) {
      throw new Error(`${sourceLabel}: unmanaged must be an array`);
    }
    for (const u of spec.unmanaged) {
      if (
        !u ||
        typeof u !== "object" ||
        Array.isArray(u) ||
        Object.keys(u as Record<string, unknown>)
          .toSorted()
          .join(",") !== "file,line,why"
      ) {
        throw new Error(`${sourceLabel}: unmanaged entries must have file, line, and why`);
      }
    }
  }

  const seenNames = new Set<string>();
  const pins: PinSpecEntry[] = [];
  for (const rawPin of spec.pins) {
    if (!rawPin || typeof rawPin !== "object" || Array.isArray(rawPin)) {
      throw new Error(`${sourceLabel}: pin entry is not an object`);
    }
    const p = rawPin as Record<string, unknown>;
    const where = `${sourceLabel}: pin ${JSON.stringify(p.name)}`;
    for (const k of Object.keys(p)) {
      if (!PIN_FIELDS.has(k)) throw new Error(`${where}: unknown field ${JSON.stringify(k)}`);
    }
    for (const req of [
      "name",
      "file",
      "lines",
      "datasource",
      "depName",
      "match",
      "assets",
      "sums",
      "writer",
    ]) {
      if (!(req in p)) throw new Error(`${where}: missing required field ${req}`);
    }
    const name = String(p.name);
    if (seenNames.has(name)) throw new Error(`${where}: declared twice`);
    seenNames.add(name);

    const hasSig = Boolean(p.signature);
    const hasUnsigned = name in unsigned;
    if (hasSig === hasUnsigned) {
      throw new Error(`${where}: must declare exactly one of signature or unsigned reason`);
    }

    const sums = p.sums as Record<string, unknown>;
    const writer = p.writer as Record<string, unknown>;
    if (typeof sums?.kind !== "string" || !SUMS.has(sums.kind)) {
      throw new Error(`${where}: unknown sums kind`);
    }
    if (typeof writer?.kind !== "string" || !WRITERS.has(writer.kind)) {
      throw new Error(`${where}: unknown writer kind`);
    }
    if (p.signature) {
      const sig = p.signature as Record<string, unknown>;
      const sigKeys = Object.keys(sig).toSorted().join(",");
      if (
        sigKeys !== "keys,over,suffix" ||
        typeof sig.keys !== "string" ||
        !(sig.keys in keys) ||
        (sig.over !== "list" && sig.over !== "asset") ||
        (sig.over === "list" && sums.kind !== "list")
      ) {
        throw new Error(`${where}: invalid signature block`);
      }
    }
    if (typeof p.match !== "string" || !p.match.includes("(?<currentValue>")) {
      throw new Error(`${where}: match must contain (?<currentValue>...)`);
    }
    const assets = p.assets as Record<string, string>;
    const isNpm = sums.kind === "npm";
    const isNoneWriter = writer.kind === "none";
    if (isNpm !== isNoneWriter) {
      throw new Error(`${where}: npm sums must pair with none writer`);
    }
    if (!isNoneWriter) {
      const writerPlatforms = Object.keys(
        ((writer.keys ?? writer.labels) as Record<string, unknown>) ?? {},
      ).toSorted();
      const assetPlatforms = Object.keys(assets).toSorted();
      if (writerPlatforms.join(",") !== assetPlatforms.join(",")) {
        throw new Error(`${where}: assets and writer name different platforms`);
      }
    }
    if (Array.isArray(p.derived)) {
      for (const d of p.derived as Array<Record<string, unknown>>) {
        const src = d.source as Record<string, unknown> | undefined;
        if (!d.name || !d.read || !src || typeof src.kind !== "string" || !SOURCES.has(src.kind)) {
          throw new Error(`${where}: derived entry is invalid`);
        }
      }
    }
    if (p.shared_check !== undefined && typeof p.shared_check !== "boolean") {
      throw new Error(`${where}: shared_check must be boolean`);
    }
    if (Boolean(p.floor) && Boolean(p.no_floor)) {
      throw new Error(`${where}: cannot declare both floor and no_floor`);
    }
    pins.push(p as unknown as PinSpecEntry);
  }

  return {
    schema: 1,
    ...(typeof spec.note === "string" ? { note: spec.note } : {}),
    pins,
    ...(Array.isArray(spec.unmanaged)
      ? { unmanaged: spec.unmanaged as PinsSpec["unmanaged"] }
      : {}),
    ...(spec.keys ? { keys: keys as unknown as Record<string, PinKeySet> } : {}),
    ...(spec.unsigned ? { unsigned: unsigned as Record<string, string> } : {}),
  };
}

export function loadPinsSpec(specPath: string): PinsSpec {
  const parsed = JSON.parse(NodeFS.readFileSync(specPath, "utf8")) as unknown;
  return validatePinsSpec(parsed, specPath);
}

/** Extracts the current pinned version from file text using the pin's Renovate regex anchor. */
export function extractCurrentPinValue(fileText: string, pin: PinSpecEntry): string {
  const re = new RegExp(pin.match);
  const match = re.exec(fileText);
  const val = match?.groups?.currentValue;
  if (!val) {
    throw new Error(`pin ${pin.name}: anchor regex did not match in ${pin.file}`);
  }
  return val;
}

/** Extracts current versions for every pin whose target file exists under `rootDir`. */
export function extractPinVersions(
  spec: PinsSpec,
  rootDir: string,
): ReadonlyArray<ExtractedPinVersion> {
  const out: ExtractedPinVersion[] = [];
  for (const pin of spec.pins) {
    const filePath = NodePath.join(rootDir, pin.file);
    if (!NodeFS.existsSync(filePath)) continue;
    const text = NodeFS.readFileSync(filePath, "utf8");
    out.push({
      name: pin.name,
      file: pin.file,
      depName: pin.depName,
      currentValue: extractCurrentPinValue(text, pin),
    });
  }
  return out;
}

/**
 * Computes per-pin SHA-256 digests (`pin:<name>` -> hex) used by the dependency hold gate.
 * For JSON manifests, digests only the pin's own lines; for scripts, digests the whole file.
 */
export function computePinDigests(
  texts: Readonly<Record<string, string>>,
  spec: PinsSpec,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const pin of spec.pins) {
    const text = texts[pin.file];
    if (text === undefined) continue;
    const whole = NodeCrypto.createHash("sha256").update(text).digest("hex");
    if (!pin.file.endsWith(".json")) {
      out[`pin:${pin.name}`] = whole;
      continue;
    }
    const matchedLines = text
      .split(/\r?\n/)
      .filter((line) => pin.lines.some((token) => line.includes(`"${token}":`)));
    out[`pin:${pin.name}`] =
      matchedLines.length > 0
        ? NodeCrypto.createHash("sha256").update(matchedLines.join("\n")).digest("hex")
        : `unresolved:${whole}`;
  }
  return out;
}

/** Generates Renovate custom regex manager definitions from `sq_pins.json`. */
export function buildRenovateCustomManagers(spec: PinsSpec): ReadonlyArray<RenovateCustomManager> {
  return spec.pins.map((pin) => ({
    customType: "regex",
    managerFilePatterns: [`/^${pin.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$/`],
    matchStrings: [pin.match],
    datasourceTemplate: pin.datasource,
    depNameTemplate: pin.depName,
    ...(pin.extractVersion ? { extractVersionTemplate: pin.extractVersion } : {}),
    ...(pin.versioning ? { versioningTemplate: pin.versioning } : {}),
  }));
}
