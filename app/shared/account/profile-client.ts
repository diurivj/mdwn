import { MAX_ACCOUNT_PROFILE_BYTES, openAccountProfile } from "~/shared/crypto/account-profile";
import { privateRequest } from "~/shared/device/private-client";
import type { RootAccess } from "~/shared/tree/client";
import { decodeTreeBytes } from "~/shared/tree/wire";

/** The actor's current Public pseudonym, opened only in this browser. */
export async function readPseudonym(access: RootAccess, signal?: AbortSignal): Promise<string> {
  const response = await privateRequest("/api/private/profile", { method: "POST", signal });
  if (!response.ok) throw new Error("Account profile unavailable");
  const profile = await response.json() as { ciphertext: string; epoch: number; revision: number };
  const opened = await openAccountProfile(decodeTreeBytes(profile.ciphertext, MAX_ACCOUNT_PROFILE_BYTES),
    access.actorVaultRootKey, { accountId: access.actorAccountId, epoch: profile.epoch, revision: profile.revision });
  return opened.publicPseudonym;
}
