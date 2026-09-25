import ts from "@typescript/typescript6";

/** One problem the generator found. `file` is relative to the project root. */
export interface BuildError {
  file: string;
  line: number;
  message: string;
}

/** Thrown when the build finds problems. `varis.json` is left untouched. */
export class BuildFailure extends Error {
  constructor(readonly errors: BuildError[]) {
    super(`varis build found ${errors.length} problem(s).`);
  }
}

/** Creates an error pointing at a node. `file` is absolute until build() relativizes it. */
export function errorAt(node: ts.Node, message: string): BuildError {
  const sourceFile = node.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return { file: sourceFile.fileName, line: line + 1, message };
}

/** Converts a TypeScript diagnostic into a build error. */
export function fromDiagnostic(diagnostic: ts.Diagnostic): BuildError {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) {
    return { file: "tsconfig.json", line: 0, message };
  }
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return { file: diagnostic.file.fileName, line: line + 1, message };
}
