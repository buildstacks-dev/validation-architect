/**
 * Provider-bound programmatic surface for @cormidia/validation-architect.
 * Importing this module performs no SDK import or call; each pinned optional
 * peer is loaded lazily only when its provider actually runs a turn.
 */

export { LocalRepository, type LocalRepositoryOptions } from "./local-repository.js";
export { RunRepository, type RunRepositoryOptions } from "./run-repository.js";
export {
  listPackagedFixtures,
  materializeFixtureTarget,
  packagedFixtureDirectory,
} from "./fixtures.js";
export { deliverRun, type DeliveryResult } from "./delivery.js";
export {
  recordCampaignCompletion,
  recordDeliveryCompletion,
  recordFidelityCompletion,
  evaluateFleetStatus,
  registryEntries,
  registryStatus,
  type RegistryEntry,
  type FleetStatus,
} from "./registry.js";
export {
  runPostHocAudit,
  runPostHocReaders,
  type PostHocAuditResult,
  type PostHocReadersResult,
} from "./posthoc.js";
export {
  runFidelity,
  type FidelityOptions,
  type FidelityResult,
  type FidelityScope,
} from "./fidelity.js";
export { LocalCampaignStore, type LocalCampaignStoreOptions } from "./local-store.js";
export {
  captureRunContext,
  listRunContexts,
  loadRunContext,
  type CaptureRunContextOptions,
  type RunContext,
} from "./run-context.js";
export {
  CLAUDE_AGENT_SDK_VERSION,
  CODEX_SDK_VERSION,
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
