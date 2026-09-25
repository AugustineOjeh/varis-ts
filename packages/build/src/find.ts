/**
 * find.ts — loads the developer's project and finds their define calls.
 *
 * WHAT THIS FILE DOES
 * 1. `loadProgram` builds a TypeScript `Program`, the compiler's in-memory
 *    model of every file in the project plus their types, from the project's
 *    own tsconfig.json. The program is only analyzed. It is never emitted or
 *    run.
 * 2. `findDefineCalls` walks every source file and returns each call
 *    expression that TypeScript resolves to OUR `Services.define` method.
 *
 * WHY MATCH BY DECLARATION INSTEAD OF BY NAME
 * Searching for the text "define(" would miss renamed instances like
 * `const v = new Varis(); v.services.define(...)`, and it would wrongly
 * match other libraries' `define` functions. Instead we ask the type
 * checker: "which method declaration does this call resolve to?" We then
 * compare that with the `define` declaration inside the copy of
 * @usevaris/sdk that this project resolves. The result is exact, whatever
 * the variable names are.
 *
 * EDGE CASES
 * - tsconfig.json lookup walks UP from the project directory
 *   (`ts.findConfigFile`), so a tsconfig.json in a parent folder is used if
 *   the project has none of its own.
 * - If @usevaris/sdk can't be resolved, or no file imports it (so it isn't
 *   in the program), there are zero define calls. The build then succeeds
 *   and writes an EMPTY services list.
 * - If the SDK resolves but has no `Services` class with a `define` method,
 *   the install is broken (or the SDK changed shape). That is a fatal
 *   BuildFailure.
 * - Declaration files (.d.ts), files from node_modules, and the SDK's own
 *   file are never searched. Only the developer's own source counts.
 * - A define call is found wherever it appears, even inside a function that
 *   is never called. This is static analysis: "written in the code" is what
 *   matters, not "executed at runtime".
 * - The SDK is resolved from the perspective of the FIRST root file. If a
 *   project somehow has several copies of @usevaris/sdk (for example in a
 *   monorepo), only calls to that one copy are found.
 *
 * !! COUPLING WITH packages/sdk/src/index.ts !!
 * `findSdkDefine` looks for a class named exactly `Services` with a method
 * named exactly `define`. If you rename either one in packages/sdk/src/index.ts, update
 * this file too, or every build will fail with "Found @usevaris/sdk but not
 * its define method." The same applies to the package name in `SDK_MODULE`,
 * which must match `name` in packages/sdk/package.json.
 */
import path from "node:path";
import ts from "@typescript/typescript6";
import { BuildFailure, fromDiagnostic } from "./errors.js";

/** The package name developers import from. Must match package.json "name". */
const SDK_MODULE = "@usevaris/sdk";

/** Loads the developer's project through its tsconfig.json. Never runs their code. */
export function loadProgram(projectDir: string): ts.Program {
  // Look for tsconfig.json in projectDir, then in each parent directory.
  // Returns the absolute path, or undefined if none is found.
  const configPath = ts.findConfigFile(
    projectDir,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    throw new BuildFailure([
      {
        file: "tsconfig.json",
        line: 0,
        message:
          "No tsconfig.json found. varis build reads your project through it.",
      },
    ]);
  }

  // Step 1 of 2: read the raw JSON. tsconfig allows comments and trailing
  // commas, so use TypeScript's reader, not JSON.parse. `read.error` is set
  // only for syntax errors.
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new BuildFailure([fromDiagnostic(read.error)]);

  // Step 2 of 2: interpret the JSON. This resolves "extends", expands
  // "include"/"exclude" into a concrete file list (`fileNames`), and
  // validates compiler options. Relative paths resolve against the folder
  // that contains tsconfig.json.
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) {
    throw new BuildFailure(parsed.errors.map(fromDiagnostic));
  }

  // Build the program with the developer's own options, so types resolve
  // exactly as they do in their editor. `noEmit` is forced on as a safety
  // net. We never call program.emit(), but this ensures no .js files could
  // ever be written.
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
}

/**
 * Finds every call the type checker resolves to the SDK's `define` method.
 * Matching is by declaration, never by name, so lookalikes are ignored and
 * renamed instances are still found.
 *
 * Returns calls in file order, then source order within each file. Returns
 * [] if the project doesn't use the SDK.
 */
export function findDefineCalls(program: ts.Program): ts.CallExpression[] {
  // The `define` method node inside the SDK. Every matching call must resolve to it.
  const defineDeclaration = findSdkDefine(program);
  if (!defineDeclaration) return [];

  const checker = program.getTypeChecker();
  const sdkFile = defineDeclaration.getSourceFile();
  const calls: ts.CallExpression[] = [];

  // `getSourceFiles()` includes EVERYTHING the program loaded: the
  // developer's files, lib.d.ts, @types, node_modules, and so on.
  for (const sourceFile of program.getSourceFiles()) {
    // Skip anything that isn't the developer's own source code.
    if (
      sourceFile === sdkFile ||
      sourceFile.isDeclarationFile ||
      program.isSourceFileFromExternalLibrary(sourceFile)
    ) {
      continue;
    }

    // Depth-first walk over every syntax node in the file.
    const visit = (node: ts.Node): void => {
      // A call counts only if TypeScript picks our exact `define`
      // declaration as the function it calls. `?.` handles calls the
      // checker can't resolve.
      if (
        ts.isCallExpression(node) &&
        checker.getResolvedSignature(node)?.declaration === defineDeclaration
      ) {
        calls.push(node);
      }
      // Keep descending, even into a matched call, so define calls nested
      // anywhere are still found.
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return calls;
}

/**
 * Locates `Services.define` in the copy of the SDK this project resolves.
 *
 * Returns undefined when the project doesn't use the SDK at all. Throws
 * BuildFailure when the SDK is present but doesn't contain the expected
 * method.
 */
function findSdkDefine(program: ts.Program): ts.MethodDeclaration | undefined {
  // Module resolution needs a "from" file. Any root file works because they
  // share one tsconfig. No root files means an empty project.
  const containingFile = program.getRootFileNames()[0];
  if (!containingFile) return undefined;

  // Resolve "@usevaris/sdk" exactly as an `import` in the developer's code
  // would, honoring their moduleResolution, `paths`, package.json
  // "exports", and so on. The positional args are (moduleName,
  // containingFile, options, host, cache, redirectedReference,
  // resolutionMode). ESNext as the resolution mode means "resolve as an ES
  // `import`", which selects the "import" condition in package.json
  // "exports", not "require".
  const resolved = ts.resolveModuleName(
    SDK_MODULE,
    containingFile,
    program.getCompilerOptions(),
    ts.sys,
    undefined,
    undefined,
    ts.ModuleKind.ESNext,
  ).resolvedModule;
  if (!resolved) return undefined;

  // Not in the program means no file imports the SDK, so there are no services.
  const sdkFile = program.getSourceFile(resolved.resolvedFileName);
  if (!sdkFile) return undefined;

  // Scan the SDK file's top-level statements for `class Services { define(...) }`.
  // In an installed package this is dist/index.d.ts, where it appears as
  // `declare class Services`. In this repo's tests, `paths` points at
  // packages/sdk/src/index.ts instead. Both shapes are handled the same way.
  for (const statement of sdkFile.statements) {
    if (
      !ts.isClassDeclaration(statement) || statement.name?.text !== "Services"
    ) continue;
    for (const member of statement.members) {
      if (
        ts.isMethodDeclaration(member) &&
        member.name.getText(sdkFile) === "define"
      ) {
        return member;
      }
    }
  }

  // The SDK file is there but its shape is wrong: a corrupt install, or a
  // rename in packages/sdk/src/index.ts that wasn't mirrored above.
  throw new BuildFailure([
    {
      file: sdkFile.fileName,
      line: 0,
      message:
        `Found ${SDK_MODULE} but not its define method. Reinstall ${SDK_MODULE}.`,
    },
  ]);
}
