import { afterEach, describe, expect, it, vi } from "vitest";
import { Varis, VarisKeyFetchError, type VarisPublicKey } from "../src/index.js";
import { VARIS_SIGNING_KEYS_URL } from "../src/constants.js";

interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicKey: VarisPublicKey;
}

async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const base64 = btoa(String.fromCharCode(...spki));
  const pem = `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----\n`;
  return {
    kid,
    privateKey: pair.privateKey,
    publicKey: { kid, public_key_pem: pem },
  };
}

/** Signs the way the gateway does: Ed25519 over UTF-8 `${timestamp}.${rawBody}`. */
async function signedRequest(
  key: TestKey,
  body: string,
  options: { timestamp?: number; headers?: Record<string, string | null> } = {},
): Promise<Request> {
  const timestamp = String(
    options.timestamp ?? Math.floor(Date.now() / 1000),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      key.privateKey,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  );
  const headers: Record<string, string | null> = {
    "content-type": "application/json",
    "x-varis-timestamp": timestamp,
    "x-varis-signature": btoa(String.fromCharCode(...signature)),
    "x-varis-key-id": key.kid,
    ...options.headers,
  };
  return new Request("https://provider.example.com/weather", {
    method: "POST",
    body,
    headers: Object.fromEntries(
      Object.entries(headers).filter(
        (entry): entry is [string, string] => entry[1] !== null,
      ),
    ),
  });
}

/** Stubs fetch to serve the given key lists, one per call. The last one repeats. */
function serveKeys(...responses: VarisPublicKey[][]) {
  const fetchMock = vi.fn(async (_url: string | URL | Request) => {
    const keys = responses.length > 1 ? responses.shift()! : responses[0]!;
    return Response.json({ keys });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const BODY = JSON.stringify({ city: "Lagos", note: "café" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Varis.verifyRequest", () => {
  it("accepts a correctly signed request", async () => {
    const key = await makeKey("k1");
    const fetchMock = serveKeys([key.publicKey]);

    const varis = new Varis();
    expect(await varis.verifyRequest(await signedRequest(key, BODY))).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe(VARIS_SIGNING_KEYS_URL);
  });

  it("caches keys across requests", async () => {
    const key = await makeKey("k1");
    const fetchMock = serveKeys([key.publicKey]);
    const varis = new Varis();

    await varis.verifyRequest(await signedRequest(key, BODY));
    await varis.verifyRequest(await signedRequest(key, BODY));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses keysUrl when set", async () => {
    const key = await makeKey("k1");
    const fetchMock = serveKeys([key.publicKey]);
    const keysUrl = "http://localhost:3000/.well-known/varis-signing-keys";

    await new Varis({ keysUrl }).verifyRequest(await signedRequest(key, BODY));

    expect(fetchMock.mock.calls[0]![0]).toBe(keysUrl);
  });

  it("rejects a tampered body", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);
    const signed = await signedRequest(key, BODY);
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: BODY.replace("Lagos", "Abuja"),
    });

    expect(await new Varis().verifyRequest(tampered)).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);
    const timestamp = Math.floor(Date.now() / 1000) - 301;

    const request = await signedRequest(key, BODY, { timestamp });
    expect(await new Varis().verifyRequest(request)).toBe(false);
  });

  it("rejects a future timestamp", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);
    const timestamp = Math.floor(Date.now() / 1000) + 301;

    const request = await signedRequest(key, BODY, { timestamp });
    expect(await new Varis().verifyRequest(request)).toBe(false);
  });

  it("honors maxClockSkewSeconds", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);
    const timestamp = Math.floor(Date.now() / 1000) - 120;

    const varis = new Varis({ maxClockSkewSeconds: 60 });
    expect(
      await varis.verifyRequest(await signedRequest(key, BODY, { timestamp })),
    ).toBe(false);
  });

  it("refetches once for an unknown key ID and accepts it when it appears", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const k1 = await makeKey("k1");
    const k2 = await makeKey("k2");
    const fetchMock = serveKeys([k1.publicKey], [k1.publicKey, k2.publicKey]);
    const varis = new Varis();

    expect(await varis.verifyRequest(await signedRequest(k1, BODY))).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(await varis.verifyRequest(await signedRequest(k2, BODY))).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown key ID that never appears, refetching at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const k1 = await makeKey("k1");
    const rogue = await makeKey("rogue");
    const fetchMock = serveKeys([k1.publicKey]);
    const varis = new Varis();

    expect(await varis.verifyRequest(await signedRequest(k1, BODY))).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(await varis.verifyRequest(await signedRequest(rogue, BODY))).toBe(
      false,
    );
    expect(await varis.verifyRequest(await signedRequest(rogue, BODY))).toBe(
      false,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects requests with missing headers", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);
    const varis = new Varis();

    for (const name of ["x-varis-signature", "x-varis-timestamp"]) {
      const request = await signedRequest(key, BODY, {
        headers: { [name]: null },
      });
      expect(await varis.verifyRequest(request)).toBe(false);
    }
  });

  it("uses the only known key when the key ID is missing", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);

    const request = await signedRequest(key, BODY, {
      headers: { "x-varis-key-id": null },
    });
    expect(await new Varis().verifyRequest(request)).toBe(true);
  });

  it("rejects a missing key ID when more than one key is known", async () => {
    const k1 = await makeKey("k1");
    const k2 = await makeKey("k2");
    serveKeys([k1.publicKey, k2.publicKey]);

    const request = await signedRequest(k1, BODY, {
      headers: { "x-varis-key-id": null },
    });
    expect(await new Varis().verifyRequest(request)).toBe(false);
  });

  it("rejects a malformed signature", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);
    const varis = new Varis();

    for (const signature of ["not base64!", btoa("too short")]) {
      const request = await signedRequest(key, BODY, {
        headers: { "x-varis-signature": signature },
      });
      expect(await varis.verifyRequest(request)).toBe(false);
    }
  });

  it("leaves the body readable", async () => {
    const key = await makeKey("k1");
    serveKeys([key.publicKey]);
    const request = await signedRequest(key, BODY);

    expect(await new Varis().verifyRequest(request)).toBe(true);
    expect(await request.json()).toEqual(JSON.parse(BODY));
  });

  it("makes no network request when publicKeys is set", async () => {
    const key = await makeKey("k1");
    const other = await makeKey("k2");
    const fetchMock = serveKeys([]);
    const varis = new Varis({ publicKeys: [key.publicKey] });

    expect(await varis.verifyRequest(await signedRequest(key, BODY))).toBe(true);
    expect(await varis.verifyRequest(await signedRequest(other, BODY))).toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws VarisKeyFetchError when the keys can't be fetched", async () => {
    const key = await makeKey("k1");
    const request = await signedRequest(key, BODY);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await expect(new Varis().verifyRequest(request.clone())).rejects.toThrow(
      VarisKeyFetchError,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(new Varis().verifyRequest(request)).rejects.toThrow(
      VarisKeyFetchError,
    );
  });
});
