/**
 * validation-architect-design — programmatic surface (CLI-first; these are
 * the exported adapters the decision record names). Importing this module
 * performs no SDK CALL — provider SDK modules are loaded but no session,
 * socket, or credential is touched until a TurnPort actually runs a turn.
 * (The CLI goes further: it imports the provider port lazily so --help never
 * loads an SDK module at all.)
 */

export { LocalRepository, type LocalRepositoryOptions } from "./local-repository.js";
export { RunRepository, type RunRepositoryOptions } from "./run-repository.js";
export {
  listPackagedFixtures,
  materializeFixtureTarget,
  packagedFixtureDirectory,
} from "./fixtures.js";
export { LocalCampaignStore, type LocalCampaignStoreOptions } from "./local-store.js";
export {
  captureRunContext,
  listRunContexts,
  loadRunContext,
  type CaptureRunContextOptions,
  type RunContext,
} from "./run-context.js";
export {
  DEFAULT_MODELS,
  LocalTurnPort,
  buildDesignerQueryOptions,
  buildReadOnlyQueryOptions,
  buildStakeholderThreadOptions,
  evaluateDesignerToolUse,
  evaluateReadOnlyToolUse,
  modelForSeat,
  type LocalTurnPortConfig,
  type LocalTurnPolicyConfig,
  type LocalTurnPortModels,
  type ToolDecision,
} from "./provider-port.js";
