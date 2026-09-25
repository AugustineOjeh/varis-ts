/**
 * errors.ts — the one error shape the whole generator speaks.
 *
 * WHAT THIS FILE DOES
 * Defines `BuildError`, a single problem with a file, a line, and a message,
 * and `BuildFailure`, the exception that carries a list of them. It also has
 * two helpers that create a `BuildError` from a position in the code:
 *   - `errorAt(node, message)`: we found the problem ourselves, at this syntax node.
 *   - `fromDiagnostic(diag)`:   TypeScript found the problem and gave us a diagnostic.
 *
 * CONVENTIONS EVERY CONTRIBUTOR SHOULD KNOW
 * - `line` is 1-based, as shown in editors. TypeScript's positions are
 *   0-based, so both helpers add 1.
 * - `line: 0` means "no specific line": the problem is with the whole file,
 *   for example "varis.json isn't valid JSON" or "No tsconfig.json found".
 * - `file` is ABSOLUTE when it comes out of these helpers. `build()` in
 *   build.ts makes it relative to the project before anyone sees it. Errors
 *   built by hand, such as `{ file: "varis.json", ... }` in write.ts and
 *   find.ts, use relative paths directly.
 * - Messages are shown to developers as they are. Write them as full
 *   sentences that say what to do, for example "Use an array instead."
 *
 * ORDINARY PROBLEMS VS. FATAL PROBLEMS
 * For ordinary problems, push a `BuildError` onto the shared `errors` array
 * and keep going, so the developer sees everything in one run. Throw
 * `BuildFailure` directly only when there is no point continuing, for example
 * when there is no tsconfig.json.
 *
 * The shape of `BuildError` is part of the CLI's output protocol (see
 * cli.ts). Don't rename or add fields casually.
 */
import ts from "@typescript/typescript6";

/** One problem the generator found. `file` is relative to the project root. */
export interface BuildError {
  file: string;
  line: number;
  message: string;
}

/** Thrown when the build finds problems. `varis.json` is left untouched. */
export class BuildFailure extends Error {
  // `readonly errors` in the constructor parameter list declares a public
  // `errors` property and assigns it in one step (TypeScript "parameter property").
  constructor(readonly errors: BuildError[]) {
    super(`varis build found ${errors.length} problem(s).`);
  }
}

/** Creates an error pointing at a node. `file` is absolute until build() relativizes it. */
export function errorAt(node: ts.Node, message: string): BuildError {
  const sourceFile = node.getSourceFile();
  // Use getStart(sourceFile), not node.pos. `pos` includes leading
  // whitespace and comments, so it can point at the line ABOVE the code.
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  // +1 converts TypeScript's 0-based line to the 1-based line editors show.
  return { file: sourceFile.fileName, line: line + 1, message };
}

/** Converts a TypeScript diagnostic into a build error. */
export function fromDiagnostic(diagnostic: ts.Diagnostic): BuildError {
  // A diagnostic message can be a chain of nested messages ("Type X is not
  // assignable... / Property y is missing..."). Flatten it into one string,
  // one message per line.
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  // Diagnostics with no file or position come from compiler configuration,
  // for example a bad option in tsconfig.json. Blame tsconfig.json, with no line.
  if (!diagnostic.file || diagnostic.start === undefined) {
    return { file: "tsconfig.json", line: 0, message };
  }
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  // +1: 0-based line -> 1-based line.
  return { file: diagnostic.file.fileName, line: line + 1, message };
}
