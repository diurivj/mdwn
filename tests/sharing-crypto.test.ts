import { describe, it } from "vitest";
import { cases } from "./support/sharing-crypto-contract";

describe("sharing crypto public API (Node)", () => {
  for (const contract of cases) it(contract.name, contract.run);
});
