/** @t3tools/surface: feature surface queries, contract intent, and onboarding. */
export {
  CONTRACT_NAMES,
  DEFAULT_CONTRACT,
  declaredContracts,
  declaredSurface,
  findContractPath,
  findRepoRoot,
  generateCommand,
  readTreeGuardConf,
  type ContractName,
} from "./surfaceLocate.ts";
export {
  authCounts,
  authText,
  clientServices,
  domainRows,
  matchRoutes,
  routeMatchesQuery,
  surfaceTotals,
  type FeatureSurface,
  type SurfaceRoute,
  type SurfaceService,
} from "./surfaceQuery.ts";
export {
  canonical,
  contractDiff,
  contractValues,
  modifiedFields,
  recordsAuth,
  routeMatches,
  surfaceItems,
  type ChangeAction,
  type ContractChange,
} from "./surfaceIntentItems.ts";
export {
  judgeIntent,
  parseIntent,
  type AuditedChange,
  type Declared,
} from "./surfaceIntentJudge.ts";
export {
  checkIntent,
  contractChanges,
  exitCodeOf,
  intentFiles,
  renderIntentResults,
  type IntentResult,
  type Verdict,
} from "./surfaceIntentCheck.ts";
export {
  AGENTS_BLURB,
  GENERATE_SCRIPT,
  initSurface,
  templateFiles,
  templatesDir,
} from "./surfaceInit.ts";
export { EXIT_UNPROVEN, HELP, runSurfaceCli, type SurfaceCliIo } from "./cli.ts";
