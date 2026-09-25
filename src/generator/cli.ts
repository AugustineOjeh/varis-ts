#!/usr/bin/env node
/**
 * The command `varis build` runs inside a TypeScript project.
 *
 * Contract, shared by every language SDK's generator:
 * - Exit 0: varis.json is written. stdout holds one JSON line: { "services": [slugs] }.
 * - Exit 1: nothing is written. stderr holds one JSON line per problem: { "file", "line", "message" }.
 * - Exit 2: the generator itself crashed. stderr holds one JSON line with the details.
 *
 * WHAT THIS FILE DOES
 * This is the executable that package.json publishes as the `varis-sdk-build`
 * bin. The Varis CLI (`varis build`) runs it in the developer's project
 * directory and parses its output. Its only job is to call `build()` and turn
 * the result into the exit-code and JSON-lines contract above. All the real
 * work happens in build.ts.
 *
 * BEFORE YOU CHANGE THIS FILE
 * - The contract above is a PROTOCOL. The Varis CLI and every other language's
 *   SDK generator depend on it. Don't change exit codes, streams, or JSON
 *   shapes without changing all of them together.
 * - Write only the JSON lines described above to stdout and stderr. No
 *   console.log, progress messages, or colors: stray output breaks the
 *   parser on the other side.
 * - The project directory is always `process.cwd()`. There are no flags or
 *   arguments.
 * - The shebang on line 1 must stay the very first line so the compiled
 *   dist/generator/cli.js can run directly.
 */
import { build } from "./build.js";
import { BuildFailure } from "./errors.js";

try {
  // Success: print { "services": ["slug-a", "slug-b"] } and exit 0 (implicitly).
  const result = build(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Expected failure: problems in the developer's code or config. Print one
  // JSON line per problem so the Varis CLI can show them all, then exit 1.
  if (error instanceof BuildFailure) {
    for (const item of error.errors) {
      process.stderr.write(`${JSON.stringify(item)}\n`);
    }
    process.exit(1);
  }
  // Anything else is a bug in the generator itself. Keep the stack trace,
  // which is what we'll need to debug it, but wrap it in the same
  // { file, line, message } shape so the other side can still parse it.
  // Throwing a non-Error value like a string is legal in JS, hence String().
  const message = error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
  process.stderr.write(`${JSON.stringify({ file: "", line: 0, message })}\n`);
  process.exit(2);
}
