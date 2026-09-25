import type { ServiceDefinition } from "./types.js";

export type { ServiceDefinition } from "./types.js";

class Services {
  /**
   * Declares a Varis service. Does nothing at runtime.
   *
   * `varis build` reads this call from your source code. `Input` and `Output`
   * become the service's input and output JSON Schemas. Every value you pass
   * must be a literal, not a variable or environment value.
   */
  define<InputSchema, OutputSchema>(definition: ServiceDefinition): void {
    void definition;
  }
}

export class Varis {
  readonly services = new Services();
}
