import type { ServiceDefinition } from "./types.js";
import { RequestVerifier, type VarisOptions } from "./verify.js";

export type {
  ServiceCategory,
  ServiceDefinition,
  ServiceStatus,
  ServiceType,
} from "./types.js";
export {
  VarisKeyFetchError,
  type VarisOptions,
  type VarisPublicKey,
} from "./verify.js";

class Services {
  /**
   * Declares a Varis service. Does nothing at runtime.
   *
   * `varis build` reads this call from your source code. `Input` and `Output`
   * become the service's input and output JSON Schemas. Every value you pass
   * must be a literal, not a variable or environment value.
   */
  define<Input, Output>(definition: ServiceDefinition): void {
    void definition;
  }
}

export class Varis {
  readonly services = new Services();
  readonly #verifier: RequestVerifier;

  /** `options` holds request verification settings only. Varis never needs a credential. */
  constructor(options: VarisOptions = {}) {
    this.#verifier = new RequestVerifier(options);
  }

  /**
   * Checks that `request` was signed by the Varis gateway. Call it before you
   * read the body. The body stays readable afterward.
   *
   * Resolves to false for any invalid or unsigned request. Rejects with
   * `VarisKeyFetchError` only when the signing keys can't be loaded.
   */
  verifyRequest(request: Request): Promise<boolean> {
    return this.#verifier.verify(request);
  }
}
