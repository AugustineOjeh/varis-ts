import fs from "node:fs";
import path from "node:path";
import { BuildFailure } from "./errors.js";

/** One service as written to varis.json: definition fields plus both schemas. */
export type ManifestService = Record<string, unknown>;

const FIELD_ORDER = [
  "slug",
  "name",
  "description",
  "service_type",
  "categories",
  "endpoint_url",
  "price_cents",
  "version",
  "status",
  "input_schema",
  "output_schema",
];

/**
 * Rewrites the `services` list in varis.json and leaves every other field,
 * including `owner_id`, as it was. Output is sorted so repeat builds produce
 * identical files.
 */
export function writeManifest(projectDir: string, services: ManifestService[]): void {
  const file = path.join(projectDir, "varis.json");

  if (!fs.existsSync(file)) {
    throw new BuildFailure([{ file: "varis.json", line: 0, message: "varis.json not found. Run varis init first." }]);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new BuildFailure([{ file: "varis.json", line: 0, message: "varis.json isn't valid JSON." }]);
  }

  if (typeof manifest.owner_id !== "string" || manifest.owner_id.length === 0) {
    throw new BuildFailure([{ file: "varis.json", line: 0, message: "varis.json has no owner_id. Run varis init." }]);
  }

  const sorted = [...services]
    .sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
    .map(orderFields);

  fs.writeFileSync(file, `${JSON.stringify({ ...manifest, services: sorted }, null, 2)}\n`);
}

function orderFields(service: ManifestService): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) {
    if (key in service) ordered[key] = service[key];
  }
  for (const key of Object.keys(service).sort()) {
    if (!(key in ordered)) ordered[key] = service[key];
  }
  return ordered;
}