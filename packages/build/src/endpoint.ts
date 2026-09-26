/**
 * endpoint.ts — where Varis calls each service.
 *
 * WHAT THIS FILE DOES
 * A define call names its endpoint one of two ways:
 *   - `endpoint_url`: the full URL, used as written.
 *   - `path`: joined to `base_url` in varis.json, for example
 *     "https://api.example.com" + "/v1/weather".
 * `resolveEndpoint` turns either into the `endpoint_url` written to
 * varis.json, which is what the Varis API publishes. `path` itself is never
 * written.
 *
 * WHY base_url LIVES IN varis.json
 * It is the production address, committed with the code. A base URL built
 * from an environment variable could ship a staging endpoint by mistake, and
 * the generator can't read one anyway, because it never runs code.
 *
 * WHY THE GENERATOR ENFORCES "EXACTLY ONE"
 * The type could express it as a union, but TypeScript reports a violation as
 * "Type 'string' is not assignable to type 'undefined'", which tells a
 * developer nothing. These messages say what to do. The type still requires
 * `path` to start with "/".
 *
 * The resolved URL is checked against the rules the Varis API applies at
 * publish, so a bad URL fails here, with a file and line, rather than later.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";
import { type BuildError, errorAt } from "./errors.js";
import type { Literal } from "./read.js";

/** Hosts a published endpoint can never live on. Mirrors the Varis API. */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "host.docker.internal",
]);

/** Why `url` can't be a Varis endpoint, or undefined if it can. */
function endpointProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "isn't a valid absolute URL";
  }
  if (parsed.protocol !== "https:") return "must use https";
  if (BLOCKED_HOSTS.has(parsed.hostname)) {
    return "must be publicly reachable, not a local address";
  }
  if (parsed.search !== "" || url.includes("?")) {
    return "can't include a query string. Declare query values as Input fields instead";
  }
  if (parsed.hash !== "" || url.includes("#")) {
    return "can't include a fragment";
  }
  return undefined;
}

/**
 * The `base_url` from varis.json, or undefined when it isn't set. Records an
 * error when it is set but can't be used.
 *
 * A missing or unparseable varis.json isn't reported here. writeManifest
 * reports those, once, with the fix.
 */
export function readBaseUrl(
  projectDir: string,
  errors: BuildError[],
): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(projectDir, "varis.json"), "utf8"),
    );
  } catch {
    return undefined;
  }

  const baseUrl = (manifest as { base_url?: unknown } | null)?.base_url;
  if (baseUrl === undefined) return undefined;

  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    errors.push({
      file: "varis.json",
      line: 0,
      message: 'base_url must be a URL, for example "https://api.example.com".',
    });
    return undefined;
  }

  const problem = endpointProblem(baseUrl);
  if (problem) {
    errors.push({
      file: "varis.json",
      line: 0,
      message: `base_url ${problem}. Use your production address, for example "https://api.example.com".`,
    });
    return undefined;
  }

  // One slash between base and path, however base_url ends.
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The endpoint_url to write for this define call, or undefined after
 * recording why there isn't one.
 */
export function resolveEndpoint(
  call: ts.CallExpression,
  fields: Record<string, Literal>,
  baseUrl: string | undefined,
  errors: BuildError[],
): string | undefined {
  const endpointUrl = fields.endpoint_url;
  const servicePath = fields.path;

  if (endpointUrl !== undefined && servicePath !== undefined) {
    errors.push(
      errorAt(
        call,
        "Set endpoint_url or path, not both. endpoint_url is the full URL; path is joined to base_url in varis.json.",
      ),
    );
    return undefined;
  }

  if (endpointUrl === undefined && servicePath === undefined) {
    errors.push(
      errorAt(
        call,
        'Set path, joined to base_url in varis.json, or endpoint_url, the full URL. For example path: "/v1/weather".',
      ),
    );
    return undefined;
  }

  // A non-string value is already a type error from step 2.
  if (typeof endpointUrl === "string") {
    const problem = endpointProblem(endpointUrl);
    if (problem) {
      errors.push(errorAt(call, `endpoint_url ${problem}.`));
      return undefined;
    }
    return endpointUrl;
  }

  if (typeof servicePath !== "string") return undefined;

  if (baseUrl === undefined) {
    errors.push(
      errorAt(
        call,
        'path needs base_url in varis.json. Add your production address, for example "base_url": "https://api.example.com", or set endpoint_url instead.',
      ),
    );
    return undefined;
  }

  const resolved = `${baseUrl}${servicePath}`;
  const problem = endpointProblem(resolved);
  if (problem) {
    errors.push(
      errorAt(call, `The endpoint ${resolved}, from base_url and path, ${problem}.`),
    );
    return undefined;
  }
  return resolved;
}
