import { describe, expect, it } from "vitest";

import { PrivateAccessError } from "../app/shared/device/private-client";
import { SharingChangedError, SharingPageLimitError } from "../app/shared/sharing/relationships-client";
import { sharingLoadState } from "../app/shared/sharing/sharing-errors";

describe("sharingLoadState", () => {
  it("reports the relationship page cap as too large, not as a retryable failure", () => {
    expect(sharingLoadState(new SharingPageLimitError())).toBe("too-large");
  });

  it("keeps access states and maps everything else to a failure", () => {
    expect(sharingLoadState(new PrivateAccessError("signed-out"))).toBe("signed-out");
    expect(sharingLoadState(new PrivateAccessError("unavailable"))).toBe("unavailable");
    expect(sharingLoadState(new SharingChangedError())).toBe("failed");
    expect(sharingLoadState(new Error("boom"))).toBe("failed");
  });
});
