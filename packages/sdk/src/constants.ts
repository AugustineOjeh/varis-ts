/** The Varis API. The only place the hostname appears in the SDK. */
export const VARIS_API_ORIGIN = "https://api.varis.my";

/** Where the gateway publishes the public keys it signs requests with. */
export const VARIS_SIGNING_KEYS_URL =
  `${VARIS_API_ORIGIN}/.well-known/varis-signing-keys`;
