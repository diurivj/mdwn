import { describe, expect, it } from "vitest";

import { cases } from "./support/namespace-v1-contract";

describe("mdwn/namespace-v1 public contract", () => {
  for (const contract of cases) {
    it(contract.name, contract.run);
  }
});
