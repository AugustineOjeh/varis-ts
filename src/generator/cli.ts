#!/usr/bin/env node
/**
 * The command `varis build` runs inside a TypeScript project.
 *
 * Contract, shared by every language SDK's generator:
 * - Exit 0: varis.json is written. stdout holds one JSON line: { "services": [slugs] }.
 * - Exit 1: nothing is written. stderr holds one JSON line per problem: { "file", "line", "message" }.
 * - Exit 2: the generator itself crashed. stderr holds one JSON line with the details.
 */
import { build } from "./build.js";
import { BuildFailure } from "./errors.js";

try {
  const result = build(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  if (error instanceof BuildFailure) {
    for (const item of error.errors) {
      process.stderr.write(`${JSON.stringify(item)}\n`);
    }
    process.exit(1);
  }
  const message = error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
  process.stderr.write(`${JSON.stringify({ file: "", line: 0, message })}\n`);
  process.exit(2);
}
