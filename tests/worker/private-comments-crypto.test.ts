import { describe, it } from "vitest";
import { cases } from "../support/private-comments-contract";

describe("Private Comment public crypto (workerd)", () => {
  for (const contract of cases) it(contract.name, contract.run);
});
