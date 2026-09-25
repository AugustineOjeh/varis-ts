/**
 * verify.ts — checks that a request really comes from the Varis gateway.
 *
 * SIGNING FORMAT (must match lib/crypto/signing.ts in the private varis repo)
 * - `x-varis-timestamp`: Unix time in whole seconds.
 * - `x-varis-signature`: base64 Ed25519 signature over the UTF-8 bytes of
 *   `${timestamp}.${rawBody}`.
 * - `x-varis-key-id`: the `kid` of the key that signed it.
 * Public keys come from VARIS_SIGNING_KEYS_URL as
 * `{ "keys": [{ "kid", "public_key_pem" }] }`, where the PEM is SPKI.
 *
 * ERROR MODEL
 * Anything wrong with the request itself returns false. Only a failure to
 * load the keys throws (`VarisKeyFetchError`), because that is the
 * provider's problem, not the caller's, and should become a 500, not a 401.
 *
 * Web APIs only: no `node:` imports, so this runs on Node, Deno, Bun, and
 * Cloudflare Workers.
 */
import { VARIS_SIGNING_KEYS_URL } from "./constants.js";

/** One public key, in the shape the signing keys endpoint returns. */
export interface VarisPublicKey {
  kid: string;
  /** SPKI public key in PEM format. */
  public_key_pem: string;
}

/** Request verification settings. Varis never needs a credential. */
export interface VarisOptions {
  /** Where to fetch signing keys from. Defaults to the Varis API. For local development. */
  keysUrl?: string;
  /** Use these keys instead of fetching any. */
  publicKeys?: VarisPublicKey[];
  /** How far a request's timestamp may be from now, in seconds. Defaults to 300. */
  maxClockSkewSeconds?: number;
}

/** Thrown when the signing keys can't be loaded. Respond with 500, not 401. */
export class VarisKeyFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VarisKeyFetchError";
  }
}

const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;
/** An unknown key ID triggers at most one refetch per this interval. */
const REFETCH_INTERVAL_MS = 60_000;
const SIGNATURE_BYTES = 64;
const encoder = new TextEncoder();

/** Holds one Varis instance's key cache. */
export class RequestVerifier {
  readonly #keysUrl: string;
  readonly #publicKeys: readonly VarisPublicKey[] | undefined;
  readonly #maxSkew: number;
  /** kid -> imported key. Replaced as a whole on every successful load. */
  #keys = new Map<string, CryptoKey>();
  /** False until the first successful load. */
  #loaded = false;
  /** Date.now() of the last fetch attempt, for the refetch throttle. */
  #lastFetch = Number.NEGATIVE_INFINITY;
  /** The in-flight load, shared by concurrent requests. */
  #loading: Promise<void> | undefined;

  constructor(options: VarisOptions = {}) {
    this.#keysUrl = options.keysUrl ?? VARIS_SIGNING_KEYS_URL;
    this.#publicKeys = options.publicKeys;
    this.#maxSkew = options.maxClockSkewSeconds ??
      DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  }

  async verify(request: Request): Promise<boolean> {
    const signatureHeader = request.headers.get("x-varis-signature");
    const timestampHeader = request.headers.get("x-varis-timestamp");
    const kid = request.headers.get("x-varis-key-id");
    if (!signatureHeader || !timestampHeader) return false;

    if (!/^\d+$/.test(timestampHeader)) return false;
    const timestamp = Number(timestampHeader);
    if (Math.abs(Date.now() / 1000 - timestamp) > this.#maxSkew) return false;

    const signature = decodeBase64(signatureHeader);
    if (!signature || signature.length !== SIGNATURE_BYTES) return false;

    if (request.bodyUsed) {
      throw new TypeError("Call verifyRequest before reading the request body.");
    }
    // Read a clone, so the caller can still read the original body.
    const body = new Uint8Array(await request.clone().arrayBuffer());

    const key = await this.#key(kid);
    if (!key) return false;

    // The signed bytes are UTF-8 `${timestamp}.${rawBody}`. The body is used
    // byte for byte, never decoded and re-encoded.
    const prefix = encoder.encode(`${timestampHeader}.`);
    const signed = new Uint8Array(prefix.length + body.length);
    signed.set(prefix);
    signed.set(body, prefix.length);

    try {
      return await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        signature,
        signed,
      );
    } catch {
      return false;
    }
  }

  /**
   * The key for `kid`, or undefined if it isn't known. A missing kid uses
   * the only key when exactly one is known. Throws VarisKeyFetchError if the
   * keys can't be loaded.
   */
  async #key(kid: string | null): Promise<CryptoKey | undefined> {
    if (!this.#loaded) await this.#load();

    if (kid === null) {
      if (this.#keys.size !== 1) return undefined;
      return this.#keys.values().next().value;
    }

    const known = this.#keys.get(kid);
    if (known) return known;

    // Unknown kid: the keys may have rotated. Refetch, but at most once per
    // interval, so random kids can't make every request hit the network.
    if (
      this.#publicKeys ||
      Date.now() - this.#lastFetch < REFETCH_INTERVAL_MS
    ) {
      return undefined;
    }
    await this.#load();
    return this.#keys.get(kid);
  }

  /** Loads and imports every key, sharing one load among concurrent callers. */
  #load(): Promise<void> {
    this.#loading ??= this.#fetchAndImport().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #fetchAndImport(): Promise<void> {
    let entries: readonly VarisPublicKey[];
    if (this.#publicKeys) {
      entries = this.#publicKeys;
    } else {
      this.#lastFetch = Date.now();
      entries = await fetchKeys(this.#keysUrl);
    }

    const keys = new Map<string, CryptoKey>();
    for (const entry of entries) {
      try {
        keys.set(entry.kid, await importPublicKey(entry.public_key_pem));
      } catch (error) {
        throw new VarisKeyFetchError(
          `Couldn't import Varis signing key "${entry.kid}".`,
          { cause: error },
        );
      }
    }
    this.#keys = keys;
    this.#loaded = true;
  }
}

/** Fetches the key list. Throws VarisKeyFetchError on any failure. */
async function fetchKeys(url: string): Promise<VarisPublicKey[]> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new VarisKeyFetchError(
      `Couldn't fetch Varis signing keys from ${url}.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new VarisKeyFetchError(
      `Couldn't fetch Varis signing keys from ${url}: HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new VarisKeyFetchError(
      `Varis signing keys from ${url} aren't valid JSON.`,
      { cause: error },
    );
  }

  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || !keys.every(isPublicKey)) {
    throw new VarisKeyFetchError(
      `Varis signing keys from ${url} don't have the expected shape.`,
    );
  }
  return keys;
}

function isPublicKey(value: unknown): value is VarisPublicKey {
  const key = value as Partial<VarisPublicKey> | null;
  return typeof key?.kid === "string" &&
    typeof key.public_key_pem === "string";
}

/** Imports an SPKI PEM as an Ed25519 verification key. */
function importPublicKey(pem: string): Promise<CryptoKey> {
  const der = decodeBase64(
    pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""),
  );
  if (!der) throw new TypeError("The public key PEM isn't valid base64.");
  return crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, [
    "verify",
  ]);
}

/** Decodes standard base64, or returns undefined if it isn't valid. */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
