import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** Live load of a devtools job's process tree (root PID and all descendants) on its host. */
export const DevtoolsJobLoad = Schema.Struct({
  /** Summed %CPU across the tree, in percent of one core. */
  cpuPct: NonNegativeInt,
  /** Summed resident set size across the tree. */
  memBytes: NonNegativeInt,
  processCount: NonNegativeInt,
});
export type DevtoolsJobLoad = typeof DevtoolsJobLoad.Type;
