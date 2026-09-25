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

export interface BuildResult {
  /** Slugs written to varis.json, sorted. */
  services: string[];
}

/**
 * Finds every define call in the project, converts it, and rewrites
 * varis.json. Collects every problem before failing. Writes nothing if any
 * problem is found.
 */
export function build(projectDir: string): BuildResult {
  try {
    return run(projectDir);
  } catch (error) {
    if (!(error instanceof BuildFailure)) throw error;
    throw new BuildFailure(
      error.errors.map((item) => relativize(item, projectDir)),
    );
  }
}

function run(projectDir: string): BuildResult {
  const program = loadProgram(projectDir);
  const checker = program.getTypeChecker();
  const calls = findDefineCalls(program);

  const errors: BuildError[] = [];
  const services: ManifestService[] = [];
  const slugs = new Map<string, ts.Node>();
  const diagnosticsByFile = new Map<ts.SourceFile, readonly ts.Diagnostic[]>();

  for (const call of calls) {
    errors.push(...typeErrorsIn(call, program, diagnosticsByFile));

    const fields = readDefinition(call, errors);
    const schemas = convertSchemas(call, checker, errors);
    if (!fields || !schemas) continue;

    const slug = fields.slug;
    if (typeof slug === "string") {
      const first = slugs.get(slug);
      if (first) {
        const { file, line } = errorAt(first, "");
        errors.push(
          errorAt(
            call,
            `The slug "${slug}" is already defined in ${
              path.relative(projectDir, file)
            } on line ${line}.`,
          ),
        );
        continue;
      }
      slugs.set(slug, call);
    }

    services.push({ ...fields, ...schemas });
  }

  if (errors.length > 0) throw new BuildFailure(errors);

  writeManifest(projectDir, services);
  return { services: services.map((service) => String(service.slug)).sort() };
}

/** Type errors inside the define call, such as a missing field or a wrong value type. */
function typeErrorsIn(
  call: ts.CallExpression,
  program: ts.Program,
  cache: Map<ts.SourceFile, readonly ts.Diagnostic[]>,
): BuildError[] {
  const sourceFile = call.getSourceFile();
  let diagnostics = cache.get(sourceFile);
  if (!diagnostics) {
    diagnostics = program.getSemanticDiagnostics(sourceFile);
    cache.set(sourceFile, diagnostics);
  }

  const start = call.getStart(sourceFile);
  const end = call.getEnd();
  return diagnostics
    .filter((diagnostic) =>
      diagnostic.start !== undefined && diagnostic.start >= start &&
      diagnostic.start < end
    )
    .map(fromDiagnostic);
}

function relativize(error: BuildError, projectDir: string): BuildError {
  return path.isAbsolute(error.file)
    ? { ...error, file: path.relative(projectDir, error.file) }
    : error;
}
