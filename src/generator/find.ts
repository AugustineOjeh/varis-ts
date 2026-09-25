import path from "node:path";
import ts from "@typescript/typescript6";
import { BuildFailure, fromDiagnostic } from "./errors.js";

const SDK_MODULE = "@usevaris/sdk";

/** Loads the developer's project through its tsconfig.json. Never runs their code. */
export function loadProgram(projectDir: string): ts.Program {
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

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new BuildFailure([fromDiagnostic(read.error)]);

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
  );
  if (parsed.errors.length > 0) {
    throw new BuildFailure(parsed.errors.map(fromDiagnostic));
  }

  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
}

/**
 * Finds every call the type checker resolves to the SDK's `define` method.
 * Matching is by declaration, never by name, so lookalikes are ignored and
 * renamed instances are still found.
 */
export function findDefineCalls(program: ts.Program): ts.CallExpression[] {
  const defineDeclaration = findSdkDefine(program);
  if (!defineDeclaration) return [];

  const checker = program.getTypeChecker();
  const sdkFile = defineDeclaration.getSourceFile();
  const calls: ts.CallExpression[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile === sdkFile ||
      sourceFile.isDeclarationFile ||
      program.isSourceFileFromExternalLibrary(sourceFile)
    ) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        checker.getResolvedSignature(node)?.declaration === defineDeclaration
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return calls;
}

/** Locates `Services.define` in the copy of the SDK this project resolves. */
function findSdkDefine(program: ts.Program): ts.MethodDeclaration | undefined {
  const containingFile = program.getRootFileNames()[0];
  if (!containingFile) return undefined;

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

  throw new BuildFailure([
    {
      file: sdkFile.fileName,
      line: 0,
      message:
        `Found ${SDK_MODULE} but not its define method. Reinstall ${SDK_MODULE}.`,
    },
  ]);
}
