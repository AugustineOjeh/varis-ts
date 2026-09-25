import ts from "@typescript/typescript6";
import { errorAt, type BuildError } from "./errors.js";

export type Literal = string | number | boolean | Literal[];

/**
 * Reads the object passed to define. Every value must be a literal, because
 * the generator never runs the developer's code. Returns undefined and
 * records errors if anything can't be read.
 */
export function readDefinition(
  call: ts.CallExpression,
  errors: BuildError[],
): Record<string, Literal> | undefined {
  const argument = call.arguments[0];
  if (!argument || !ts.isObjectLiteralExpression(unwrap(argument))) {
    errors.push(errorAt(call, "Define the service as an object inside the define call."));
    return undefined;
  }

  const fields: Record<string, Literal> = {};
  let ok = true;

  for (const property of (unwrap(argument) as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(property)) {
      errors.push(
        errorAt(
          property,
          "Write each field as `name: value`. varis build can't read spreads, shorthand properties, or methods without running your code.",
        ),
      );
      ok = false;
      continue;
    }

    const key = propertyName(property.name);
    if (key === undefined) {
      errors.push(errorAt(property.name, "Field names must be plain names, not computed values."));
      ok = false;
      continue;
    }

    const value = readLiteral(property.initializer, key, errors);
    if (value === undefined) {
      ok = false;
      continue;
    }
    fields[key] = value;
  }

  return ok ? fields : undefined;
}

function readLiteral(expression: ts.Expression, key: string, errors: BuildError[]): Literal | undefined {
  const node = unwrap(expression);

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;

  if (ts.isArrayLiteralExpression(node)) {
    const items: Literal[] = [];
    for (const element of node.elements) {
      const item = readLiteral(element, key, errors);
      if (item === undefined) return undefined;
      items.push(item);
    }
    return items;
  }

  errors.push(
    errorAt(
      node,
      `The value of "${key}" must be a literal. varis build reads your code without running it, so variables, function calls, and environment values have no value yet.`,
    ),
  );
  return undefined;
}

/** Strips wrappers that don't change the value: parentheses, `as`, and `satisfies`. */
function unwrap(expression: ts.Expression): ts.Expression {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}