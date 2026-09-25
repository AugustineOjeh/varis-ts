/**
 * read.ts — reads the VALUES out of a define call's object literal.
 *
 * WHAT THIS FILE DOES
 * Given `varis.services.define<I, O>({ slug: "weather", price_cents: 3, ... })`,
 * `readDefinition` returns `{ slug: "weather", price_cents: 3, ... }` as a
 * plain JS object. It does this by reading the SYNTAX TREE, never by running
 * the code.
 *
 * THE KEY IDEA: ONLY LITERALS
 * Because the code never runs, a value can be read only if it is written out
 * literally in the source. `slug: "weather"` works. `slug: SLUG`,
 * `slug: process.env.SLUG`, and `slug: makeSlug()` don't, because those have
 * no value until runtime.
 *
 * WHAT IS SUPPORTED (see `readLiteral`)
 * - Strings: "x", 'x', and template strings WITHOUT `${}` placeholders.
 * - Numbers, including negative numbers written as `-5`. TypeScript
 *   normalizes the text, so `1_000`, `0x10`, and `1e3` all read correctly.
 * - true / false.
 * - Arrays of any of the above, nested to any depth.
 * - Any of the above wrapped in `( )`, `as T`, `<T>`, or `satisfies T`
 *   (see `unwrap`). Wrappers on the whole object are also allowed:
 *   `define({ ... } satisfies X)`.
 *
 * WHAT IS NOT SUPPORTED (each one records an error)
 * - Nested objects as values, `null`, and `undefined`. ServiceDefinition
 *   doesn't need them today. If you add an object-valued field to
 *   src/types.ts, extend `readLiteral` and the `Literal` type.
 * - Spreads (`...base`), shorthand (`{ slug }`), methods, getters and setters.
 * - Computed keys (`[KEY]: ...`).
 * - `+5`, `!0`, and other expressions, including array spreads and holes (`[1,,2]`).
 *
 * WHAT THIS FILE DOES NOT CHECK
 * It doesn't know which fields exist or which values are valid. For example,
 * a misspelled `servce_type` or a `price_cents` of "3" gets through here.
 * Those rules live in the `ServiceDefinition` TYPE in src/types.ts. The
 * TypeScript compiler enforces that type, and build.ts reports its errors
 * (see `typeErrorsIn`). To add a new validation rule, change the type
 * first. Add code here only when a type can't express the rule.
 *
 * ERROR BEHAVIOR
 * - Inside the object, every bad field is reported, not just the first.
 * - Inside an array, reading stops at the first bad element, so only one
 *   error is reported per array.
 * - If anything failed, the function returns undefined and build.ts skips
 *   the service. Its errors are already recorded.
 */
import ts from "@typescript/typescript6";
import { errorAt, type BuildError } from "./errors.js";

/** Every value shape readLiteral can produce. Extend it when adding support for new value kinds. */
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
  // define takes one argument: the definition object.
  const argument = call.arguments[0];
  // It must be an inline object literal. `define(myConfig)` points at a
  // variable whose value we can't read without running code.
  if (!argument || !ts.isObjectLiteralExpression(unwrap(argument))) {
    errors.push(errorAt(call, "Define the service as an object inside the define call."));
    return undefined;
  }

  const fields: Record<string, Literal> = {};
  // Goes false as soon as any field fails. We keep looping anyway so every
  // bad field gets reported.
  let ok = true;

  // The cast is safe: the check above confirmed the unwrapped argument is an object literal.
  for (const property of (unwrap(argument) as ts.ObjectLiteralExpression).properties) {
    // Only plain `name: value` pairs are allowed. This rejects `...spread`,
    // `{ shorthand }`, `method() {}`, and `get x() {}`.
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

    // The field name as a string. undefined means it's a computed key like `[KEY]`.
    const key = propertyName(property.name);
    if (key === undefined) {
      errors.push(errorAt(property.name, "Field names must be plain names, not computed values."));
      ok = false;
      continue;
    }

    // `initializer` is the part after the colon. readLiteral records its own
    // error on failure, so we only need to flag the failure here.
    const value = readLiteral(property.initializer, key, errors);
    if (value === undefined) {
      ok = false;
      continue;
    }
    // If a key appears twice, the last one wins, as in JavaScript. TypeScript
    // already reports duplicate keys as a type error.
    fields[key] = value;
  }

  // All or nothing: a partially read definition is never returned.
  return ok ? fields : undefined;
}

/**
 * Turns one value expression into a JS value, or records an error and
 * returns undefined. `key` is the top-level field name, used only for the
 * error message. Array items report the key of the array they're in.
 */
function readLiteral(expression: ts.Expression, key: string, errors: BuildError[]): Literal | undefined {
  // Look through ( ), as, <T>, and satisfies. They don't change the value.
  const node = unwrap(expression);

  // "x", 'x', and `x` (a template with no ${} placeholders). `.text` is the
  // value with the quotes removed and escapes already processed.
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // `.text` is TypeScript's normalized decimal form, for example
  // 1_000 -> "1000" and 0x10 -> "16", so Number() is safe.
  if (ts.isNumericLiteral(node)) return Number(node.text);
  // Negative numbers aren't literals in the syntax tree. `-5` is the unary
  // minus operator applied to the literal 5, so it's handled separately.
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  // true and false are keywords, not literal nodes, so compare the node kind.
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;

  // Arrays: read each element recursively, e.g. categories: ["science", "ai"].
  if (ts.isArrayLiteralExpression(node)) {
    const items: Literal[] = [];
    for (const element of node.elements) {
      const item = readLiteral(element, key, errors);
      // Stop at the first bad element. Its error is already recorded.
      if (item === undefined) return undefined;
      items.push(item);
    }
    return items;
  }

  // Anything else: identifiers, calls, property access, objects, null, and
  // so on. To support a new kind of value, add a branch ABOVE this line.
  errors.push(
    errorAt(
      node,
      `The value of "${key}" must be a literal. varis build reads your code without running it, so variables, function calls, and environment values have no value yet.`,
    ),
  );
  return undefined;
}

/**
 * Strips wrappers that don't change the value: parentheses, `as`, `<T>`
 * type assertions, and `satisfies`. Loops because wrappers can stack, as in
 * `(x as const) satisfies T`.
 */
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

/**
 * The field name as a string, for `slug:`, `"slug":`, or `1:`. Returns
 * undefined for anything that needs evaluation, such as computed keys
 * (`[KEY]:`) or private names (`#x`).
 */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}
