/**
 * `fleet check`: the one fleet check. The shape must parse in the one schema
 * (every object closed), and its cross-references and secret rotation
 * stories must hold. The same rules judge every repo; repo differences are
 * declaration data.
 */
import { parseEntities } from "./fleetEntities.ts";
import { type FleetFinding, fleetFindings } from "./fleetFindings.ts";
import { isObject, schemaErrors } from "./fleetSchemaNodes.ts";
import { FLEET_SHAPE_SCHEMA } from "./fleetShapeSchema.ts";

export interface FleetCheckResult {
  readonly file: string;
  readonly ok: boolean;
  readonly entityCount: number;
  readonly schemaErrors: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<FleetFinding>;
}

/** Judges a parsed fleet shape; `file` names it in the report. */
export function checkFleetShape(shape: unknown, file: string): FleetCheckResult {
  const errors = schemaErrors(FLEET_SHAPE_SCHEMA, shape);
  let entityCount = 0;
  try {
    entityCount = parseEntities(shape, file).length;
  } catch {
    entityCount = 0;
  }
  // The rules read declared references; a shape that is not an object has none.
  const findings = isObject(shape) ? fleetFindings(shape) : [];
  return {
    file,
    ok: errors.length === 0 && findings.length === 0,
    entityCount,
    schemaErrors: errors,
    findings,
  };
}
