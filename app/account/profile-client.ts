import { openAccountProfile } from "~/crypto/account-profile";
import { privateRequest } from "~/device/private-client";
import type { RootAccess } from "~/tree/client";
import { decodeTreeBytes } from "~/tree/wire";

const PROFILE_CIPHERTEXT_BYTES = 4_096;

/** The actor's current Public pseudonym, opened only in this browser. */
export async function readPseudonym(access: RootAccess, signal?: AbortSignal): Promise<string> {
  const response = await privateRequest("/api/private/profile", { method: "POST", signal });
  if (!response.ok) throw new Error("Account profile unavailable");
  const profile = await response.json() as { ciphertext: string; epoch: number; revision: number };
  const opened = await openAccountProfile(decodeTreeBytes(profile.ciphertext, PROFILE_CIPHERTEXT_BYTES),
    access.actorVaultRootKey, { accountId: access.actorAccountId, epoch: profile.epoch, revision: profile.revision });
  return opened.publicPseudonym;
}
