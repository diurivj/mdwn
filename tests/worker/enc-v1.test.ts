import { describe, it } from "vitest";
import { cases } from "../support/enc-v1-contract";

describe("enc-v1 shared vectors (workerd)", () => {
  for (const contract of cases) it(contract.name, contract.run);
});
