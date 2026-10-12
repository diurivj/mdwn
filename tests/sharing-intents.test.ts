import { beforeEach, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ cleared: 0, leaveGrant: vi.fn(), revokeGrant: vi.fn() }));
vi.mock("../app/shared/device/private-tab-memory", async (original) => ({
  ...(await original<typeof import("../app/shared/device/private-tab-memory")>()),
  clearPrivateMemoryInAllTabs: () => {
    fakes.cleared += 1;
  },
}));
vi.mock("../app/shared/sharing/relationships-client", async (original) => ({
  ...(await original<typeof import("../app/shared/sharing/relationships-client")>()),
  leaveGrant: fakes.leaveGrant,
  revokeGrant: fakes.revokeGrant,
}));

import { expiryFromDate, runSharingIntent } from "../app/shared/sharing/sharing-intents";

const GRANT = "01890a5d-ac96-774b-bcce-b302099a8057";
const form = (intent: string) => {
  const data = new FormData();
  data.set("intent", intent);
  data.set("id", GRANT);
  data.set("revision", "3");
  return data;
};

beforeEach(() => {
  fakes.cleared = 0;
  fakes.leaveGrant.mockReset();
  fakes.revokeGrant.mockReset();
});

it("turns a chosen future date into the end of that local day, and refuses anything else", () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  expect(expiryFromDate("2026-10-13", now)).toBe(new Date(2026, 9, 13, 23, 59, 59, 999).getTime());
  expect(expiryFromDate("2026-10-12", now)).toBe(new Date(2026, 9, 12, 23, 59, 59, 999).getTime());
  for (const value of ["2026-10-11", "2026-02-30", "2026-13-01", "tomorrow", "", null, 1_900_000_000_000])
    expect(expiryFromDate(value, now)).toBeNull();
});

it("forgets remembered private memory in every tab after leaving a Grant, whatever the answer", async () => {
  fakes.leaveGrant.mockResolvedValueOnce(undefined);
  expect((await runSharingIntent(form("leave"), new AbortController().signal)).state).toBe("done");
  expect(fakes.leaveGrant).toHaveBeenCalledWith(GRANT, 3, expect.any(AbortSignal));
  expect(fakes.cleared).toBe(1);

  fakes.leaveGrant.mockRejectedValueOnce(new Error("uncertain"));
  expect((await runSharingIntent(form("leave"), new AbortController().signal)).state).not.toBe("done");
  expect(fakes.cleared).toBe(2);
});

it("keeps remembered private memory for an Owner's own Grant changes", async () => {
  fakes.revokeGrant.mockResolvedValueOnce(undefined);
  expect((await runSharingIntent(form("revoke"), new AbortController().signal)).state).toBe("done");
  expect(fakes.cleared).toBe(0);
});
