import { describe, it } from "vitest";

import { cases } from "../support/share-handle-contract";

describe("share handle v1 lookup token (workerd)", () => {
  for (const contract of cases) {
    it(contract.name, contract.run);
  }
});
