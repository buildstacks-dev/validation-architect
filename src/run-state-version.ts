import type { RunState } from "./types.js";
import { CURRENT_CORE_VERSIONS, type CoreVersionBundle } from "./versions.js";
import { acceptedBundleIdentity, assertCurrentVersionBundle, canonicalVersionedValue, versionedValueHash } from "./version-compatibility.js";

export const UNVERSIONED_RUN_RECOVERY = "adopt-current-pre1-after-compiler-validation";

export function assertRunStateVersionCompatible(state: RunState): void {
  if (!state.coreVersions) throw new Error(`run ${state.runId} has no core version bundle; recover explicitly with --recover-core-state ${UNVERSIONED_RUN_RECOVERY}`);
  assertCurrentVersionBundle(state.coreVersions);
  const compilation = state.compilation;
  if (!compilation) return;
  if (compilation.versions) assertCurrentVersionBundle(compilation.versions);
  if (compilation.status === "accepted") {
    if (!compilation.versions || !compilation.modelIdentity || !compilation.acceptedBundleIdentity) throw new Error(`run ${state.runId} accepted compilation lacks exact bundle identity or version provenance`);
    const expected = acceptedBundleIdentity({ sourceFingerprint: compilation.sourceFingerprint, surfaceFingerprint: compilation.surfaceFingerprint, modelIdentity: compilation.modelIdentity, versions: compilation.versions });
    if (compilation.acceptedBundleIdentity !== expected) throw new Error(`run ${state.runId} accepted bundle identity mismatch`);
  }
}

export function recoverUnversionedRunState(state: RunState, recoveryName: string): void {
  if (recoveryName !== UNVERSIONED_RUN_RECOVERY) throw new Error(`unknown core-state recovery ${recoveryName}`);
  if (state.coreVersions) throw new Error(`run ${state.runId} already has version provenance; recovery is not applicable`);
  if (state.compilation?.versions) assertCurrentVersionBundle(state.compilation.versions);
  if (state.compilation?.status === "accepted") throw new Error("an accepted unversioned compilation requires a reviewed schema migration, not pre-1.0 adoption");
  const pendingBefore = versionedValueHash(state.pending ?? null);
  state.coreVersions = structuredClone(CURRENT_CORE_VERSIONS);
  state.versionRecovery = {
    name: UNVERSIONED_RUN_RECOVERY,
    source: "unversioned-pre1-run-state",
    targetVersions: structuredClone(CURRENT_CORE_VERSIONS),
    pendingIdentity: pendingBefore,
  };
  if (versionedValueHash(state.pending ?? null) !== pendingBefore) throw new Error("core-state recovery changed the pending message invariant");
  void canonicalVersionedValue(state.versionRecovery);
}

export function cloneCoreVersions(value: CoreVersionBundle): CoreVersionBundle {
  return structuredClone(value);
}
