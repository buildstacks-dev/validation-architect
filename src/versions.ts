/**
 * Core interpretation stamps. These are data-contract identities, not npm
 * release policy; the package/API workstream owns public package naming and
 * release composition.
 */
export const CORE_PACKAGE_VERSION = "0.4.5";
export const METHOD_VERSION = "0.8.0";
export const MODEL_SCHEMA = "validation-architect/corpus/v1";
export const COMPILER_VERSION = "validation-architect/compiler/v1";
export const POLICY_SCHEMA = "validation-architect/policy/v1";
export const RESULT_SCHEMA = "validation-architect/result/v1";
export const GOLDEN_SET_SCHEMA = "validation-architect/golden-set/v1";

export interface CoreVersionBundle {
  package: string;
  method: string;
  model: string;
  compiler: string;
  policy: string;
  result: string;
  golden_set: string;
}

export const CURRENT_CORE_VERSIONS: Readonly<CoreVersionBundle> = Object.freeze({
  package: CORE_PACKAGE_VERSION,
  method: METHOD_VERSION,
  model: MODEL_SCHEMA,
  compiler: COMPILER_VERSION,
  policy: POLICY_SCHEMA,
  result: RESULT_SCHEMA,
  golden_set: GOLDEN_SET_SCHEMA,
});
