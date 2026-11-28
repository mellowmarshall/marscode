/** @t3tools/runlog: the one test-output summariser for MarsCode (the server, playbook and CI hosts). */
export { DETAIL_LINES, Found, type FailureDetail, type RunnerParser } from "./runlogFound.ts";
export {
  PARSERS,
  duration,
  logLines,
  report,
  summarise,
  type ReportInput,
  type Summary,
} from "./runlogSummary.ts";
export {
  NAME_MAX,
  defaultName,
  listLogs,
  openLog,
  repoName,
  shortName,
  slug,
  utcStamp,
} from "./runlogPaths.ts";
export { TAIL_BYTES, cannotRun, readLog, runCommand, signalExitCode } from "./runlogProcess.ts";
export { loadStorageRoots, logRoot, type StorageRoots } from "./runlogStorageRoots.ts";
export {
  SUITE_PRINTED,
  passThroughLine,
  runCiSuite,
  validSuiteName,
  type CiSuiteIo,
} from "./ciSuite.ts";
export { clockTicks, reapedChildTicks } from "./reapedChildCpu.ts";
export { HELP, USAGE, parseArgs, runRunlogCli, type CliIo } from "./cli.ts";
