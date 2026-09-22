import { describe, it } from "vitest";

import { cases } from "../support/namespace-v1-contract";

describe("mdwn/namespace-v1 shared vectors (workerd)", () => {
  for (const contract of cases) {
    it(contract.name, contract.run);
  }
});
