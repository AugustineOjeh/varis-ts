import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/build.js";
import { type BuildError, BuildFailure } from "../src/errors.js";
import { findWarnings } from "../src/warnings.js";

const SDK_ENTRY = path.resolve(import.meta.dirname, "../../sdk/src/index.ts");
const projects: string[] = [];

/** Creates a throwaway project whose @usevaris/sdk import resolves to packages/sdk/src. */
function makeProject(
  files: Record<string, string>,
  manifest: object | null = { owner_id: "own_123" },
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "varis-build-"));
  projects.push(dir);

  const all: Record<string, string> = {
    "package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        target: "es2022",
        noEmit: true,
        skipLibCheck: true,
        types: [],
        paths: { "@usevaris/sdk": [SDK_ENTRY] },
      },
      include: ["src"],
    }),
    ...files,
  };
  if (manifest) all["varis.json"] = `${JSON.stringify(manifest, null, 2)}\n`;

  for (const [name, content] of Object.entries(all)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function readManifest(dir: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, "varis.json"), "utf8"));
}

function buildErrors(dir: string): BuildError[] {
  try {
    build(dir);
  } catch (error) {
    if (error instanceof BuildFailure) return error.errors;
    throw error;
  }
  throw new Error("Expected the build to fail.");
}

/** A valid definition body. `overrides` replaces whole lines by field name. */
function fields(slug: string, overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    slug: `"${slug}"`,
    name: `"Service ${slug}"`,
    description: `"A test service that does something useful."`,
    service_type: `"data"`,
    categories: `["science"]`,
    endpoint_url: `"https://api.example.com/${slug}"`,
    price_cents: "3",
    ...overrides,
  };
  return Object.entries(base)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `  ${key}: ${value},`)
    .join("\n");
}

afterEach(() => {
  for (const dir of projects.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("build", () => {
  it("finds services across files and writes them sorted, keeping owner_id", () => {
    const dir = makeProject({
      "src/weather/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ city: string }, { temp: number }>({
${fields("weather")}
});`,
      "src/deep/nested/alpha.ts": `
import { Varis } from "@usevaris/sdk";
const varis = new Varis();
varis.services.define<{ q: string }, string>({
${fields("alpha")}
});`,
    });

    expect(build(dir)).toEqual({ services: ["alpha", "weather"] });

    const manifest = readManifest(dir);
    expect(manifest.owner_id).toBe("own_123");
    expect(manifest.services.map((service: any) => service.slug)).toEqual([
      "alpha",
      "weather",
    ]);
    expect(manifest.services[1]).toMatchObject({
      endpoint_url: "https://api.example.com/weather",
      price_cents: 3,
      categories: ["science"],
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      output_schema: {
        type: "object",
        properties: { temp: { type: "number" } },
        required: ["temp"],
      },
    });
  });

  it("converts arrays, optional fields, literal unions, booleans, null, records, and doc comments", () => {
    const dir = makeProject({
      "src/types.ts": `
export interface Input {
  /** The city to look up. */
  city: string;
  units?: "metric" | "imperial";
  include_history: boolean;
}
export interface Output {
  data: Array<{ max_temp: number; min_temp: number | null }>;
  tags: Record<string, string>;
}`,
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
import type { Input, Output } from "./types.js";
new Varis().services.define<Input, Output>({
${fields("weather")}
});`,
    });

    build(dir);
    const [service] = readManifest(dir).services;

    expect(service.input_schema).toEqual({
      type: "object",
      properties: {
        city: { description: "The city to look up.", type: "string" },
        units: { type: "string", enum: ["metric", "imperial"] },
        include_history: { type: "boolean" },
      },
      required: ["city", "include_history"],
    });
    expect(service.output_schema).toEqual({
      type: "object",
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              max_temp: { type: "number" },
              min_temp: { anyOf: [{ type: "null" }, { type: "number" }] },
            },
            required: ["max_temp", "min_temp"],
          },
        },
        tags: {
          type: "object",
          properties: {},
          additionalProperties: { type: "string" },
        },
      },
      required: ["data", "tags"],
    });
  });

  it("finds a renamed instance", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis as V } from "@usevaris/sdk";
const client = new V();
const services = client.services;
services.define<{ a: string }, string>({
${fields("renamed")}
});`,
    });

    expect(build(dir).services).toEqual(["renamed"]);
  });

  it("ignores a lookalike define", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
void Varis;
const varis = { services: { define<I, O>(_definition: unknown) {} } };
varis.services.define<{ a: string }, string>({ slug: "fake" });`,
    });

    expect(build(dir).services).toEqual([]);
  });

  it("fails on a computed value and leaves varis.json untouched", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
const url = "https://api.example.com/x";
new Varis().services.define<{ a: string }, string>({
${fields("computed", { endpoint_url: "url" })}
});`,
    });
    const before = fs.readFileSync(path.join(dir, "varis.json"), "utf8");

    const errors = buildErrors(dir);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: path.join("src", "route.ts"),
      line: 10,
    });
    expect(errors[0]!.message).toContain('"endpoint_url" must be a literal');
    expect(fs.readFileSync(path.join(dir, "varis.json"), "utf8")).toBe(before);
  });

  it("fails on a type with no JSON Schema equivalent", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, { at: Date }>({
${fields("dated")}
});`,
    });

    const [error] = buildErrors(dir);
    expect(error).toMatchObject({
      file: path.join("src", "route.ts"),
      line: 3,
    });
    expect(error!.message).toContain("Output.at: Dates aren't JSON");
  });

  it("fails when Input isn't an object", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<string, string>({
${fields("scalar")}
});`,
    });

    expect(buildErrors(dir)[0]!.message).toContain(
      "Input must be an object type",
    );
  });

  it("fails when the type arguments are missing", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define({
${fields("untyped")}
});`,
    });

    expect(buildErrors(dir).map((error) => error.message)).toContain(
      "Pass the input and output types: define<Input, Output>({ ... }).",
    );
  });

  it("reports a missing required field from the type checker", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("unpriced", { price_cents: "" })}
});`,
    });

    expect(
      buildErrors(dir).some((error) => error.message.includes("price_cents")),
    ).toBe(true);
  });

  it("fails on a duplicate slug", () => {
    const dir = makeProject({
      "src/a.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("same")}
});`,
      "src/b.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("same")}
});`,
    });

    expect(buildErrors(dir)[0]!.message).toContain(
      'The slug "same" is already defined in src/a.ts on line 3.',
    );
  });

  it("produces identical output on a repeat build", () => {
    const dir = makeProject({
      "src/route.ts": `
import { Varis } from "@usevaris/sdk";
new Varis().services.define<{ a: string }, string>({
${fields("stable")}
});`,
    });

    build(dir);
    const first = fs.readFileSync(path.join(dir, "varis.json"), "utf8");
    build(dir);

    expect(fs.readFileSync(path.join(dir, "varis.json"), "utf8")).toBe(first);
  });

  it("fails without varis.json", () => {
    const dir = makeProject({ "src/route.ts": "export {};" }, null);

    expect(buildErrors(dir)[0]!.message).toBe(
      "varis.json not found. Run varis init first.",
    );
  });
});

describe("findWarnings", () => {
  it("warns when @usevaris/build is in dependencies", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({
        type: "module",
        dependencies: { "@usevaris/build": "^0.1.0" },
      }),
    });

    const warnings = findWarnings(dir);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@usevaris/build in dependencies");
  });

  it("stays quiet when @usevaris/build is a devDependency or absent", () => {
    const dev = makeProject({
      "package.json": JSON.stringify({
        type: "module",
        devDependencies: { "@usevaris/build": "^0.1.0" },
      }),
    });
    const absent = makeProject({});

    expect(findWarnings(dev)).toEqual([]);
    expect(findWarnings(absent)).toEqual([]);
  });

  it("skips the check when package.json is invalid", () => {
    const dir = makeProject({ "package.json": "{ not json" });

    expect(findWarnings(dir)).toEqual([]);
  });
});
