import { describe, expect, it } from "vitest";

import { openDirectory, prepareTreeCreate, type FetchedDirectory, type RootAccess } from "../app/shared/tree/client";
import { createListingHead } from "../app/shared/tree/listing";
import { encodeTreeBytes } from "../app/shared/tree/wire";

const vaultId = "019950d7-98c0-7000-8000-000000000201";
const directoryId = "019950d7-98c0-7000-8000-000000000202";
const deviceId = "019950d7-98c0-7000-8000-000000000203";
const access = { vaultId } as RootAccess;

/** A device-signed listing whose names were sealed directly, as a tampering server could arrange them. */
async function signedListing(names: readonly string[]) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const entries = [];
  for (const requestedName of names) {
    const { nodeId, kind, nameCiphertext, orderCiphertext, keyEnvelope } = await prepareTreeCreate({
      vaultId,
      parentId: directoryId,
      parentKey: key,
      entriesRevision: 1,
      existingNames: [],
      requestedName,
      kind: "directory",
    });
    entries.push({ nodeId, kind, nameCiphertext, orderCiphertext, keyEnvelope });
  }
  const head = await createListingHead(key, signing.privateKey, {
    vaultId,
    directoryId,
    deviceId,
    revision: 2,
    entries,
  });
  const signerPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey));
  const listing: FetchedDirectory = {
    directoryId,
    entriesRevision: 2,
    entries,
    listingHead: { ...head, signerDeviceId: deviceId, signerPublicKey: encodeTreeBytes(signerPublicKey) },
  };
  return { key, listing };
}

describe("opening a Directory listing", () => {
  it("opens distinct sibling names, including a large folder", async () => {
    const names = Array.from({ length: 500 }, (_, index) => `Child ${index}`);
    const { key, listing } = await signedListing(names);
    const opened = await openDirectory(access, directoryId, key, listing);
    expect(opened.entries.map((entry) => entry.name).sort()).toEqual([...names].sort());
  });

  it("refuses siblings whose names share a comparison key", async () => {
    for (const pair of [
      ["Draft.md", "DRAFT.md"],
      ["Straße", "STRASSE"],
      ["Amélie", "Amélie"],
    ]) {
      const { key, listing } = await signedListing(["Notes", ...pair]);
      await expect(openDirectory(access, directoryId, key, listing)).rejects.toThrow("invalid directory listing");
    }
  });
});
