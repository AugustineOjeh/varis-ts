/**
 * build.ts — the orchestrator. Start here if you are new to the generator.
 *
 * WHAT THIS FILE DOES
 * `build(projectDir)` turns a developer's TypeScript project into a
 * `varis.json` manifest. It never runs the developer's code. It reads the
 * code with the TypeScript compiler API, which is called "static analysis".
 * The pipeline has five steps, and each one lives in its own file:
 *
 *   1. find.ts     Load the project through its tsconfig.json and find every
 *                  `varis.services.define<Input, Output>({ ... })` call.
 *   2. (here)      Collect TypeScript's own type errors inside each call, for
 *                  example a missing `slug` or a misspelled `service_type`.
 *   3. read.ts     Read the object literal passed to define into plain values.
 *   4. convert.ts  Turn the `Input` and `Output` type arguments into JSON Schemas.
 *   5. write.ts    Merge the services into varis.json, with a stable order.
 *
 * ERROR MODEL (read this before you change anything)
 * - Nothing throws on the first problem. Every step pushes `BuildError`s into
 *   one shared `errors` array, so the developer sees every problem in one run.
 * - After every call has been processed, one or more errors means a single
 *   `BuildFailure` is thrown and varis.json is NOT touched. It is all or
 *   nothing: a half-written manifest never ships.
 * - Some steps can't continue at all, for example when tsconfig.json is
 *   missing or varis.json is invalid. Those steps throw `BuildFailure`
 *   directly (see find.ts and write.ts). `build()` catches it in the same way.
 * - Any other exception is a bug in the generator. It passes through
 *   untouched, and cli.ts reports it with exit code 2.
 *
 * FILE PATHS IN ERRORS
 * Errors made with `errorAt`/`fromDiagnostic` carry ABSOLUTE paths, because
 * that is what TypeScript gives us. `build()` turns them into project-relative
 * paths (`relativize`) just before rethrowing. If you add a new error, you
 * don't need to relativize it yourself.
 *
 * EDGE CASES HANDLED HERE
 * - Duplicate slugs: the FIRST define call with a slug wins. Every later call
 *   with the same slug gets an error that points back at the first one.
 * - A call can have type errors but still read and convert cleanly. It is
 *   still added to `services`, but the non-empty `errors` array stops the
 *   write, so that is harmless.
 * - No define calls at all: `services` is empty and varis.json is written
 *   with `"services": []`. This is intended, because it clears out services
 *   that were removed from code.
 *
 * WHERE TO MAKE CHANGES
 * - A new rule about the whole project, for example "at most N services",
 *   goes in `run()` before the `if (errors.length > 0)` check.
 * - A rule about one field's value belongs in read.ts, or better, in the
 *   `ServiceDefinition` type in src/types.ts, so that TypeScript enforces it
 *   and step 2 reports it automatically.
 */
import path from "node:path";
import ts from "@typescript/typescript6";
import { convertSchemas } from "./convert.js";
import {
  type BuildError,
  BuildFailure,
  errorAt,
  fromDiagnostic,
} from "./errors.js";
import { findDefineCalls, loadProgram } from "./find.js";
import { readDefinition } from "./read.js";
import { type ManifestService, writeManifest } from "./write.js";

/** What a successful build returns. cli.ts prints it as JSON on stdout. */
export interface BuildResult {
  /** Slugs written to varis.json, sorted. */
  services: string[];
}

/**
 * Finds every define call in the project, converts it, and rewrites
 * varis.json. Collects every problem before failing. Writes nothing if any
 * problem is found.
 *
 * This is the public entry point, used by cli.ts and the tests. It is a thin
 * wrapper around `run()` whose only job is to make file paths in errors
 * relative to `projectDir` before they reach the user.
 */
export function build(projectDir: string): BuildResult {
  try {
    return run(projectDir);
  } catch (error) {
    // Generator bugs (anything that isn't a BuildFailure) are rethrown as-is
    // so their stack trace survives. cli.ts turns them into exit code 2.
    if (!(error instanceof BuildFailure)) throw error;
    // Same failure, with every absolute path made relative to the project.
    throw new BuildFailure(
      error.errors.map((item) => relativize(item, projectDir)),
    );
  }
}

/**
 * The actual pipeline. Throws `BuildFailure` if anything is wrong. Otherwise
 * it writes varis.json and returns the sorted slugs.
 */
function run(projectDir: string): BuildResult {
  // Step 1: parse and type-check the developer's project (see find.ts).
  // loadProgram throws BuildFailure right away if tsconfig.json is missing or broken.
  const program = loadProgram(projectDir);
  // The checker answers questions like "what type is this?" and "which
  // function does this call resolve to?". convert.ts needs it.
  const checker = program.getTypeChecker();
  // Every `services.define(...)` call in the project's own source files.
  const calls = findDefineCalls(program);

  // Shared error sink. Every step below appends to it and never throws for
  // ordinary developer mistakes.
  const errors: BuildError[] = [];
  // Services that passed every step, ready to be written.
  const services: ManifestService[] = [];
  // slug -> the define call that claimed it first. Used for duplicate detection.
  const slugs = new Map<string, ts.Node>();
  // Semantic diagnostics are costly to compute and are per file, while a file
  // may contain several define calls. Cache them per file.
  const diagnosticsByFile = new Map<ts.SourceFile, readonly ts.Diagnostic[]>();

  for (const call of calls) {
    // Step 2: TypeScript's own complaints inside this call. The
    // ServiceDefinition type in src/types.ts does most of the field
    // validation (required fields, allowed enum values, and so on).
    errors.push(...typeErrorsIn(call, program, diagnosticsByFile));

    // Step 3: the object literal's values, e.g. { slug: "x", price_cents: 3 }.
    const fields = readDefinition(call, errors);
    // Step 4: { input_schema, output_schema } from define<Input, Output>.
    const schemas = convertSchemas(call, checker, errors);
    // Either step failed. Its errors are already recorded, so move on to
    // the next call and keep collecting.
    if (!fields || !schemas) continue;

    // Duplicate slug check. `slug` may be missing or not a string. The
    // ServiceDefinition type already reports that in step 2, so this check
    // is simply skipped in that case.
    const slug = fields.slug;
    if (typeof slug === "string") {
      const first = slugs.get(slug);
      if (first) {
        // errorAt is used here only to get the first call's file and line.
        // The empty message is thrown away.
        const { file, line } = errorAt(first, "");
        errors.push(
          errorAt(
            call,
            `The slug "${slug}" is already defined in ${
              path.relative(projectDir, file)
            } on line ${line}.`,
          ),
        );
        // Don't add the duplicate to `services`.
        continue;
      }
      slugs.set(slug, call);
    }

    // Merge the definition fields and the two schemas into one manifest entry.
    // write.ts decides the final key order.
    services.push({ ...fields, ...schemas });
  }

  // All or nothing: one problem anywhere means varis.json stays untouched.
  if (errors.length > 0) throw new BuildFailure(errors);

  // Step 5: write varis.json. This can still throw BuildFailure if varis.json
  // is missing, isn't valid JSON, or has no owner_id.
  writeManifest(projectDir, services);
  // `String(...)` because ManifestService values are typed `unknown`. The
  // type checker already guaranteed slug is a string by now.
  return { services: services.map((service) => String(service.slug)).sort() };
}

/**
 * Type errors inside the define call, such as a missing field or a wrong value type.
 *
 * TypeScript reports diagnostics per file. This keeps only the ones whose
 * start position falls inside this call's text range. Type errors elsewhere
 * in the developer's project are deliberately ignored: they aren't our
 * business and must not block the build.
 */
function typeErrorsIn(
  call: ts.CallExpression,
  program: ts.Program,
  cache: Map<ts.SourceFile, readonly ts.Diagnostic[]>,
): BuildError[] {
  const sourceFile = call.getSourceFile();
  // Compute each file's diagnostics at most once, however many define calls it has.
  let diagnostics = cache.get(sourceFile);
  if (!diagnostics) {
    diagnostics = program.getSemanticDiagnostics(sourceFile);
    cache.set(sourceFile, diagnostics);
  }

  // The call's character range in the file. getStart skips leading comments
  // and whitespace. getEnd is exclusive.
  const start = call.getStart(sourceFile);
  const end = call.getEnd();
  return diagnostics
    // Keep diagnostics that begin inside the call. Diagnostics without a
    // position (`start === undefined`) can't be placed, so they're dropped.
    .filter((diagnostic) =>
      diagnostic.start !== undefined && diagnostic.start >= start &&
      diagnostic.start < end
    )
    .map(fromDiagnostic);
}

/**
 * Makes an error's file path relative to the project root, for example
 * "/home/me/app/src/a.ts" -> "src/a.ts". Paths that are already relative,
 * like "varis.json" or "tsconfig.json", are left alone.
 */
function relativize(error: BuildError, projectDir: string): BuildError {
  return path.isAbsolute(error.file)
    ? { ...error, file: path.relative(projectDir, error.file) }
    : error;
}
