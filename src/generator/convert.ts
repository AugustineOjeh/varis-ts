import ts from "@typescript/typescript6";
import { type BuildError, errorAt } from "./errors.js";

export type JsonSchema = { [key: string]: unknown };

export interface Schemas {
  input_schema: JsonSchema;
  output_schema: JsonSchema;
}

/** Signals a type with no JSON Schema equivalent. Caught per schema. */
class Unsupported extends Error {}

const NON_JSON_OBJECTS: Record<string, string> = {
  Date: "Dates aren't JSON. Use a string, for example an ISO 8601 timestamp.",
  Map: "Maps aren't JSON. Use an object type instead.",
  Set: "Sets aren't JSON. Use an array instead.",
  Promise: "Promises aren't JSON. Use the resolved type instead.",
};

/**
 * Converts define's two type arguments into JSON Schemas. Supports strings,
 * numbers, booleans, null, literals and literal unions, arrays, objects,
 * optional fields, index signatures, and unions of those. Anything else
 * records an error rather than producing a partial schema.
 */
export function convertSchemas(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
  errors: BuildError[],
): Schemas | undefined {
  const typeArguments = call.typeArguments;
  if (!typeArguments || typeArguments.length !== 2) {
    errors.push(
      errorAt(
        call,
        "Pass the input and output types: define<Input, Output>({ ... }).",
      ),
    );
    return undefined;
  }

  const [inputNode, outputNode] = typeArguments as unknown as [
    ts.TypeNode,
    ts.TypeNode,
  ];
  const input = convertAt(inputNode, "Input", checker, errors);
  const output = convertAt(outputNode, "Output", checker, errors);

  if (input && input.type !== "object") {
    errors.push(
      errorAt(
        inputNode,
        "Input must be an object type, because agents send arguments by name.",
      ),
    );
    return undefined;
  }
  if (!input || !output) return undefined;

  return { input_schema: input, output_schema: output };
}

function convertAt(
  node: ts.TypeNode,
  label: string,
  checker: ts.TypeChecker,
  errors: BuildError[],
): JsonSchema | undefined {
  try {
    return convert(checker.getTypeFromTypeNode(node), label, {
      checker,
      location: node,
      stack: [],
    });
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    errors.push(errorAt(node, error.message));
    return undefined;
  }
}

interface Context {
  checker: ts.TypeChecker;
  location: ts.Node;
  stack: ts.Type[];
}

function convert(type: ts.Type, at: string, context: Context): JsonSchema {
  const { checker } = context;
  const flags = type.flags;

  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    throw new Unsupported(`${at} is any or unknown. Give it a concrete type.`);
  }
  if (flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  if (flags & ts.TypeFlags.BooleanLiteral) {
    return { type: "boolean", const: checker.typeToString(type) === "true" };
  }
  if (type.isStringLiteral()) return { type: "string", const: type.value };
  if (type.isNumberLiteral()) return { type: "number", const: type.value };
  if (flags & ts.TypeFlags.String) return { type: "string" };
  if (flags & ts.TypeFlags.Number) return { type: "number" };
  if (flags & ts.TypeFlags.Null) return { type: "null" };

  if (type.isUnion()) return convertUnion(type, at, context);

  if (flags & ts.TypeFlags.Object || type.isIntersection()) {
    return convertObject(type, at, context);
  }

  throw new Unsupported(
    `${at} has type ${
      checker.typeToString(type)
    }, which has no JSON Schema equivalent.`,
  );
}

function convertUnion(
  type: ts.UnionType,
  at: string,
  context: Context,
): JsonSchema {
  // Optional fields arrive as `T | undefined`. Optionality is recorded in `required`.
  let members = type.types.filter((member) =>
    !(member.flags & ts.TypeFlags.Undefined)
  );

  // Inside a union, TypeScript splits boolean into true | false. Rejoin it.
  const literals = members.filter((member) =>
    member.flags & ts.TypeFlags.BooleanLiteral
  );
  const hasBoolean = literals.length === 2;
  if (hasBoolean) {
    members = members.filter((member) =>
      !(member.flags & ts.TypeFlags.BooleanLiteral)
    );
  }

  if (members.length === 0 && hasBoolean) return { type: "boolean" };
  if (members.length === 1 && !hasBoolean) {
    return convert(members[0]!, at, context);
  }

  if (!hasBoolean && members.every((member) => member.isStringLiteral())) {
    return {
      type: "string",
      enum: members.map((member) => (member as ts.StringLiteralType).value),
    };
  }
  if (!hasBoolean && members.every((member) => member.isNumberLiteral())) {
    return {
      type: "number",
      enum: members.map((member) => (member as ts.NumberLiteralType).value),
    };
  }

  const anyOf = members.map((member) => convert(member, at, context));
  if (hasBoolean) anyOf.push({ type: "boolean" });
  return { anyOf };
}

function convertObject(
  type: ts.Type,
  at: string,
  context: Context,
): JsonSchema {
  const { checker, location, stack } = context;

  if (stack.includes(type)) {
    throw new Unsupported(
      `${at} refers to itself. Recursive types aren't supported.`,
    );
  }
  if (
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0
  ) {
    throw new Unsupported(`${at} is a function. Functions aren't JSON.`);
  }

  const symbolName = type.getSymbol()?.getName() ?? "";
  const nonJson = NON_JSON_OBJECTS[symbolName];
  if (nonJson) throw new Unsupported(`${at}: ${nonJson}`);

  const reference = type as ts.TypeReference;
  if (reference.target && reference.target.objectFlags & ts.ObjectFlags.Tuple) {
    throw new Unsupported(
      `${at} is a tuple. Use an array or an object type instead.`,
    );
  }

  const inner: Context = { ...context, stack: [...stack, type] };

  if (symbolName === "Array" || symbolName === "ReadonlyArray") {
    const [item] = checker.getTypeArguments(reference);
    if (!item) throw new Unsupported(`${at} is an array with no item type.`);
    return { type: "array", items: convert(item, `${at}[]`, inner) };
  }

  const schema: JsonSchema = { type: "object" };
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const property of checker.getPropertiesOfType(type)) {
    const name = property.getName();
    let child = convert(
      checker.getTypeOfSymbolAtLocation(property, location),
      `${at}.${name}`,
      inner,
    );

    const description = ts.displayPartsToString(
      property.getDocumentationComment(checker),
    ).trim();
    if (description) child = { description, ...child };

    properties[name] = child;
    if (!(property.flags & ts.SymbolFlags.Optional)) required.push(name);
  }

  schema.properties = properties;
  if (required.length > 0) schema.required = required;

  const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (index) {
    schema.additionalProperties = convert(index.type, `${at}[key]`, inner);
  }

  return schema;
}
