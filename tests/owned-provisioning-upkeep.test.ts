import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const privateClient = vi.hoisted(() => ({
  generation: 0,
  privateRequest: vi.fn<(path: string, options: { method: string }) => Promise<Response>>(),
}));

vi.mock("../app/shared/device/private-client", () => ({
  deviceStateGeneration: () => privateClient.generation,
  privateRequest: privateClient.privateRequest,
}));

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const complete = () => Response.json({ state: "complete", item: null });
const pending = () => Response.json({ state: "pending", kind: "recovery_owned", item: null });

let ownedProvisioningUpkeep: typeof import("../app/shared/device/owned-provision-client").ownedProvisioningUpkeep;

beforeEach(async () => {
  // A fresh module per test: the remembered answer is module memory.
  vi.resetModules();
  ({ ownedProvisioningUpkeep } = await import("../app/shared/device/owned-provision-client"));
  privateClient.generation = 0;
  privateClient.privateRequest.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("owned-key provisioning upkeep (ticket 57)", () => {
  it("reads the owned job at most once a minute while there is none", async () => {
    privateClient.privateRequest.mockImplementation(async () => complete());
    expect(await ownedProvisioningUpkeep()).toBeNull();
    vi.mocked(Date.now).mockReturnValue(NOW + MINUTE - 1);
    expect(await ownedProvisioningUpkeep()).toBeNull();
    expect(privateClient.privateRequest).toHaveBeenCalledTimes(1);
    expect(privateClient.privateRequest).toHaveBeenCalledWith("/api/private/recovery-provision/next", {
      method: "POST",
      signal: undefined,
    });
    vi.mocked(Date.now).mockReturnValue(NOW + MINUTE);
    expect(await ownedProvisioningUpkeep()).toBeNull();
    expect(privateClient.privateRequest).toHaveBeenCalledTimes(2);
  });

  it("never remembers a pending job or a failed read", async () => {
    privateClient.privateRequest.mockImplementationOnce(async () => pending());
    expect(await ownedProvisioningUpkeep()).toBe("recovery");
    privateClient.privateRequest.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await expect(ownedProvisioningUpkeep()).rejects.toThrow();
    privateClient.privateRequest.mockImplementationOnce(async () => complete());
    expect(await ownedProvisioningUpkeep()).toBeNull();
    expect(privateClient.privateRequest).toHaveBeenCalledTimes(3);
  });

  it("reads again after an authentication change discards device state", async () => {
    privateClient.privateRequest.mockImplementation(async () => complete());
    await ownedProvisioningUpkeep();
    privateClient.generation++;
    privateClient.privateRequest.mockImplementation(async () => pending());
    expect(await ownedProvisioningUpkeep()).toBe("recovery");
    expect(privateClient.privateRequest).toHaveBeenCalledTimes(2);
  });
});
