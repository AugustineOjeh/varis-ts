import { describe, expect, it } from "vitest";
import { Varis } from "../src/index.js";

describe("Varis.services.define", () => {
  it("does nothing at runtime", () => {
    const varis = new Varis();

    const result = varis.services.define<{ city: string }, { temp: number }>({
      slug: "weather",
      name: "Weather",
      description: "Returns the current temperature for any city.",
      service_type: "data",
      categories: ["science"],
      endpoint_url: "https://api.example.com/weather",
      price_cents: 3,
    });

    expect(result).toBeUndefined();
  });
});
