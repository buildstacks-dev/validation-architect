/**
 * Minimal structural JSON-schema-subset validator used to validate structured
 * turn output against a TurnRequest's `outputSchema`. Supports the subset the
 * campaign engine emits: type, const, enum, required, properties,
 * additionalProperties (boolean), items, minItems, maxItems, minLength,
 * maxLength, minimum.
 * Hand-rolled because the core package's only runtime dependency is `yaml`.
 */

import { isRecord } from "./validate.js";
import type { JsonSchema } from "./ports.js";

export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "output", problems: string[] = []): string[] {
  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return problems;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return problems;
  }
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) {
      problems.push(`${path} must be an object`);
      return problems;
    }
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (value[key] === undefined) problems.push(`${path}.${key} is required`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined && isRecord(child)) {
        validateAgainstSchema(value[key], child, `${path}.${key}`, problems);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) problems.push(`${path}.${key} is not permitted`);
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) {
      problems.push(`${path} must be an array`);
      return problems;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${path} must have at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      problems.push(`${path} must have at most ${schema.maxItems} item(s)`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) => validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`, problems));
    }
  } else if (type === "string") {
    if (typeof value !== "string") problems.push(`${path} must be a string`);
    else if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      problems.push(`${path} must have length >= ${schema.minLength}`);
    }
    else if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      problems.push(`${path} must have length <= ${schema.maxLength}`);
    }
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) {
      problems.push(`${path} must be a ${type}`);
    } else if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push(`${path} must be >= ${schema.minimum}`);
    }
  } else if (type === "boolean") {
    if (typeof value !== "boolean") problems.push(`${path} must be a boolean`);
  }
  return problems;
}
