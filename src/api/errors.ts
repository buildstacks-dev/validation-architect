/**
 * Typed public failure taxonomy (VA-API-002). The `code` field is the machine
 * discriminator; message text may explain but is never contract.
 */

export type PublicErrorCode =
  | "invalid_input"
  | "invalid_output"
  | "unsupported_schema_major"
  | "version_mismatch"
  | "stale_generation"
  | "invalid_checkpoint"
  | "identity_mismatch";

export class PublicContractError extends Error {
  readonly code: PublicErrorCode;
  /** Machine-readable context: offending paths, expected/actual values. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: PublicErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PublicContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isPublicContractError(value: unknown, code?: PublicErrorCode): value is PublicContractError {
  return value instanceof PublicContractError && (code === undefined || value.code === code);
}

export function invalidInput(message: string, details: Record<string, unknown> = {}): PublicContractError {
  return new PublicContractError("invalid_input", message, details);
}

export function invalidOutput(message: string, details: Record<string, unknown> = {}): PublicContractError {
  return new PublicContractError("invalid_output", message, details);
}

export function unsupportedSchemaMajor(
  schemaId: string,
  supported: readonly string[],
): PublicContractError {
  return new PublicContractError(
    "unsupported_schema_major",
    `Schema ${schemaId} is outside the supported range [${supported.join(", ")}]. An explicit migrate is the only upgrade path.`,
    { schemaId, supported: [...supported] },
  );
}

export function versionMismatch(message: string, details: Record<string, unknown> = {}): PublicContractError {
  return new PublicContractError("version_mismatch", message, details);
}

export function staleGeneration(expected: number, actual: number, runId: string): PublicContractError {
  return new PublicContractError(
    "stale_generation",
    `Checkpoint save for run ${runId} expected generation ${expected} but the store holds ${actual}; another process advanced the campaign.`,
    { expected, actual, runId },
  );
}

export function invalidCheckpoint(message: string, details: Record<string, unknown> = {}): PublicContractError {
  return new PublicContractError("invalid_checkpoint", message, details);
}

export function identityMismatch(message: string, details: Record<string, unknown> = {}): PublicContractError {
  return new PublicContractError("identity_mismatch", message, details);
}
