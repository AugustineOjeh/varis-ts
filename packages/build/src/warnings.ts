/**
 * warnings.ts — problems worth mentioning that don't stop the build.
 *
 * WHAT THIS FILE DOES
 * `findWarnings(projectDir)` returns human-readable strings. cli.ts prints
 * them in the `warnings` array on stdout, only on success (exit 0).
 *
 * RULES
 * - A warning never fails the build and never throws. If a check can't run,
 *   for example because package.json is missing or invalid, it is skipped.
 * - Warnings never go to stderr. stderr is reserved for the JSON error lines
 *   described in cli.ts.
 * - Write each warning as full sentences that say what to do.
 */
import fs from "node:fs";
import path from "node:path";

/** This package's own name. Must match package.json "name". */
const BUILD_PACKAGE = "@usevaris/build";

/** Returns every warning for the project. Never throws. */
export function findWarnings(projectDir: string): string[] {
  const warnings: string[] = [];

  const dependencies = readPackageJson(projectDir)?.dependencies;
  if (
    dependencies && typeof dependencies === "object" &&
    BUILD_PACKAGE in dependencies
  ) {
    warnings.push(
      `package.json lists ${BUILD_PACKAGE} in dependencies, so it ships to production. The Varis CLI runs it on demand, so remove it, or move it to devDependencies.`,
    );
  }

  return warnings;
}

/** The project's package.json as an object, or undefined if it can't be read. */
function readPackageJson(
  projectDir: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
