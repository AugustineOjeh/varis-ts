/**
 * flat-input.ts — the rule a GET service's input must follow.
 *
 * WHAT THIS FILE DOES
 * A GET service receives its input as query parameters, and a query string
 * has no nesting. So a GET service's input schema must be flat: every
 * property a string, number, boolean, literal union, or an array of those.
 * `flatInputProblems` returns every property that breaks the rule.
 *
 * WHY IT LIVES HERE AND NOT IN THE TYPE
 * `ServiceDefinition` can't see the `Input` type argument, so TypeScript
 * can't report this in step 2. The generator checks the converted schema
 * instead (see build.ts).
 *
 * KEEP IN STEP WITH THE SERVER
 * The Varis API applies the same rule at publish time, in
 * lib/schema/flat-input.ts in the private varis repository. If the two
 * disagree, a build passes and the publish fails, or the reverse. Change
 * both together.
 *
 * The schemas come from convert.ts, which inlines every type, so there is
 * never a `$ref` to follow. `null` is rejected: a query string can't carry
 * it. Use an optional field instead.
 */

export type FlatInputProblem = { path: string; message: string };

type Schema = Record<string, unknown>;

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** Root keywords that could hide structure outside `properties`. */
const COMPOSITE_ROOT_KEYWORDS = [
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "patternProperties",
  "dependentSchemas",
] as const;

function isPlainObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiteral(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean";
}

/** One query parameter value: a scalar type, a literal, or a union of those. */
function isScalarSchema(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  if ("const" in schema) return isLiteral(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.length > 0 && schema.enum.every(isLiteral);
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    return union.length > 0 && union.every(isScalarSchema);
  }
  return typeof schema.type === "string" && SCALAR_TYPES.has(schema.type);
}

function isFlatProperty(schema: unknown): boolean {
  if (isScalarSchema(schema)) return true;
  // One `items` schema only; a tuple has positions a repeated key can't keep.
  return isPlainObject(schema) && schema.type === "array" &&
    isScalarSchema(schema.items);
}

/** Every reason `schema` can't be a GET service's input. Empty means it can. */
export function flatInputProblems(schema: unknown): FlatInputProblem[] {
  if (!isPlainObject(schema) || schema.type !== "object") {
    return [{ path: "", message: "must be an object type" }];
  }

  const problems: FlatInputProblem[] = [];

  for (const keyword of COMPOSITE_ROOT_KEYWORDS) {
    if (keyword in schema) {
      problems.push({
        path: "",
        message: `can't be a union of object types (${keyword})`,
      });
    }
  }

  if (isPlainObject(schema.additionalProperties)) {
    problems.push({
      path: "",
      message:
        "can't use an index signature such as Record<string, T>, because its values aren't declared",
    });
  }

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [key, property] of Object.entries(properties)) {
    if (!isFlatProperty(property)) {
      problems.push({
        path: key,
        message:
          "must be a string, number, boolean, literal union, or an array of those",
      });
    }
  }

  return problems;
}
