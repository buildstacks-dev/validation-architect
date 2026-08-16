const SECRET_PATTERN = /(?:AKIA[A-Z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{12,}|(?:token|secret|password|authorization)=(?!\[REDACTED\])\S+)/i;
const SECRET_REDACTION_PATTERN = /AKIA[A-Z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{12,}|((?:token|secret|password|authorization)=)(?!\[REDACTED\])\S+/gi;

/** True only for complete credential-shaped tokens, not embedded prose. */
export function containsSecretPattern(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

/** Redacts the same complete credential shapes used by every public validator. */
export function redactSecretPatterns(value: string): string {
  return value.replace(
    SECRET_REDACTION_PATTERN,
    (_match, assignment: string | undefined) =>
      assignment ? `${assignment}[REDACTED]` : "[REDACTED]",
  );
}
