# @usevaris/sdk

Declare Varis services in TypeScript. The SDK turns your types into the JSON
Schemas in `varis.json`, which the Varis CLI publishes. It also verifies that
requests to your endpoints come from Varis.

## Install

```bash
npm install @usevaris/sdk
```

## Example

```ts
import { Varis } from "@usevaris/sdk";

type Input = { city: string };
type Output = { max_temp: number; min_temp: number };

const varis = new Varis();

varis.services.define<Input, Output>({
  slug: "weather",
  name: "Weather",
  description: "Returns the temperature range for any city.",
  service_type: "data",
  categories: ["science"],
  endpoint_url: "https://api.example.com/weather",
  price_cents: 3,
});
```

Then run `varis build` from the project root to update `varis.json`.

## Verify requests

In the handler that serves the service, reject any request Varis didn't sign
before you read the body:

```ts
if (!(await varis.verifyRequest(request))) {
  return new Response("Unauthorized", { status: 401 });
}
```

## Documentation

See the [Varis documentation](TODO) for setup, every field, supported types, and
publishing.

## License

MIT
