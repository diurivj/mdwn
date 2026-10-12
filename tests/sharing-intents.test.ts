import { expect, it } from "vitest";

import { expiryFromDate } from "../app/shared/sharing/sharing-intents";

it("turns a chosen future date into the end of that local day, and refuses anything else", () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  expect(expiryFromDate("2026-10-13", now)).toBe(new Date(2026, 9, 13, 23, 59, 59, 999).getTime());
  expect(expiryFromDate("2026-10-12", now)).toBe(new Date(2026, 9, 12, 23, 59, 59, 999).getTime());
  for (const value of ["2026-10-11", "2026-02-30", "2026-13-01", "tomorrow", "", null, 1_900_000_000_000])
    expect(expiryFromDate(value, now)).toBeNull();
});
