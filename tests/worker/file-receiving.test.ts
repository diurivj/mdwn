import { describe, it } from "vitest";
import { cases } from "../support/file-receiving-contract";

describe("File receiving protocol (workerd)", () => {
  for (const contract of cases) it(contract.name, contract.run);
});
