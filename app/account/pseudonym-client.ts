import { MAX_COMMENT_KEY_ENVELOPE_BYTES, sealAttribution } from "~/comments/content";
import { sealPublicAttribution } from "~/comments/public-content";
import { MAX_ACCOUNT_PROFILE_BYTES, openAccountProfile, sealAccountProfile } from "~/crypto/account-profile";
import { openVaultRecoveryEnvelope } from "~/crypto/vault";
import { loadPrivateBrowser, type PrivateBrowser } from "~/device/private-browser";
import { privateRequest } from "~/device/private-client";
import { newOpaqueId } from "~/opaque-id";
import { sealAuthorDeclaration } from "~/publications/content";
import { openCommentKeyEnvelope, type CommentKeyContext } from "~/sharing/comment-keys";
import { decodeTreeBytes, encodeTreeBytes, isV7 } from "~/tree/wire";

/**
 * Browser driver for the exclusive Public-pseudonym update (ticket 24).
 *
 * One pass stages bounded pages of re-sealed `attribution` contexts and then
 * commits. Only the browser holds the Vault root key and thread/publication
 * capabilities; the staged profile ciphertext lets any enrolled device open the
 * new pseudonym and resume an interrupted pass. No plaintext is persisted.
 */

export type PseudonymJob = { jobId: string; state: string; progress: number; createdAt: number };

/** Browser-held crypto and a proof-bound external API transport. */
export type PseudonymBrowser = PrivateBrowser & {
  request(path: string, method?: "POST" | "PUT" | "PATCH", body?: object): Promise<Response>;
};
type Options = { maxSteps?: number; signal?: AbortSignal; onProgress?: (job: PseudonymJob) => void };

export class PseudonymCooldownError extends Error {
  constructor(readonly nextChangeAt: number) { super("pseudonym_cooldown"); }
}
export class PseudonymPendingError extends Error { constructor() { super("pseudonym_update_pending"); } }
export class PseudonymPreparingError extends Error { constructor() { super("secure_access_preparing"); } }
export class PseudonymChangedError extends Error { constructor() { super("pseudonym_update_changed"); } }

type ProfileWire = { ciphertext: string; epoch: number; revision: number; nextChangeAt: number | null };
type StagedProfile = { ciphertext: string; epoch: number; revision: number };
type ThreadEnvelopeWire =
  | { mode: "owned"; keyEpoch: number; ciphertext: string }
  | ({ mode: "grant" } & CommentKeyContext & { deviceId: string; signerDeviceId: string;
      signerPublicKey: string; ciphertext: string; signature: string });
type ThreadContext = {
  kind: "thread"; recordId: string; threadId: string; epochId: string; objectId: string; fileId: string;
  ownerId: string; purpose: "private-comment-thread" | "public-comment-audience-epoch";
  publicationId: string | null; currentRevision: number; revision: number;
  capabilityId: string; capabilityEpoch: number; envelope: ThreadEnvelopeWire;
};
type PublicationContext = {
  kind: "publication"; recordId: string; publicationId: string; fileId: string; linkId: string;
  publicKey: string; currentRevision: number; revision: number;
};
type NextResponse = {
  job: PseudonymJob; profile?: StagedProfile;
  operation: "stage" | "commit" | "complete" | "cancelled";
  contexts?: (ThreadContext | PublicationContext)[]; staged?: number; total?: number;
};
export type PseudonymState = { publicPseudonym: string; nextChangeAt: number | null; job: PseudonymJob | null };

async function json<T>(browser: PseudonymBrowser, path: string,
  method: "POST" | "PUT" | "PATCH" = "POST", body?: object): Promise<T> {
  const response = await browser.request(path, method, body);
  if (response.status === 409) {
    const problem = await response.json().catch(() => null) as { error?: string; nextChangeAt?: number } | null;
    if (problem?.error === "pseudonym_cooldown") throw new PseudonymCooldownError(problem.nextChangeAt ?? 0);
    if (problem?.error === "pseudonym_update_pending") throw new PseudonymPendingError();
    if (problem?.error === "secure_access_preparing") throw new PseudonymPreparingError();
    throw new PseudonymChangedError();
  }
  if (!response.ok) throw new Error("Pseudonym update unavailable");
  return response.json() as Promise<T>;
}

/** Open one context's thread or epoch capability exactly as a comment read would. */
async function contextCapability(browser: PseudonymBrowser, context: ThreadContext): Promise<Uint8Array<ArrayBuffer>> {
  if (context.envelope.mode === "owned") {
    return openVaultRecoveryEnvelope(decodeTreeBytes(context.envelope.ciphertext, MAX_COMMENT_KEY_ENVELOPE_BYTES),
      browser.vaultRootKey, { purpose: "vault-recovery", vaultId: context.ownerId, objectId: context.objectId,
        keyId: context.capabilityId, keyEpoch: context.capabilityEpoch, revision: 1 });
  }
  return openCommentKeyEnvelope({ ...context.envelope, recipient: browser.transportKeyPair });
}

/** Re-seal one context's displayed pseudonym at its next revision. */
async function sealContext(browser: PseudonymBrowser, context: ThreadContext | PublicationContext,
  pseudonym: string): Promise<{ kind: "thread" | "publication"; revision: number; ciphertext: string;
    contentKeyEnvelope: string | null }> {
  if (context.kind === "publication") {
    return { kind: "publication", revision: context.revision,
      ciphertext: encodeTreeBytes(await sealAuthorDeclaration({ publicationId: context.publicationId,
        linkId: context.linkId, publicKey: decodeTreeBytes(context.publicKey, 65),
        declarationId: context.recordId, revision: context.revision }, pseudonym)),
      contentKeyEnvelope: null };
  }
  const capability = await contextCapability(browser, context);
  if (context.purpose === "private-comment-thread") {
    const sealed = await sealAttribution(capability, { vaultId: context.ownerId, attributionId: context.recordId,
      pseudonym, capabilityId: context.capabilityId, keyEpoch: context.capabilityEpoch, revision: context.revision });
    return { kind: "thread", revision: context.revision, ciphertext: sealed.ciphertext,
      contentKeyEnvelope: sealed.contentKeyEnvelope };
  }
  if (!context.publicationId) throw new Error("Invalid pseudonym context");
  const sealed = await sealPublicAttribution(capability, { publicationId: context.publicationId,
    attributionId: context.recordId, pseudonym, capabilityId: context.capabilityId,
    keyEpoch: context.capabilityEpoch, revision: context.revision });
  return { kind: "thread", revision: context.revision, ciphertext: sealed.ciphertext,
    contentKeyEnvelope: sealed.contentKeyEnvelope };
}

/** A generated, non-identifying pseudonym in the signup format. */
export function generatePseudonym(): string {
  return `Member ${encodeTreeBytes(crypto.getRandomValues(new Uint8Array(9)))}`;
}

/** Stage bounded pages and commit. Returns true when the job is complete. */
export async function runPseudonymUpdate(jobId: string, browser: PseudonymBrowser, options: Options = {}): Promise<boolean> {
  if (!isV7(jobId)) throw new Error("Invalid pseudonym update job");
  const maxSteps = options.maxSteps ?? 25;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) throw new Error("Invalid pseudonym update bound");
  let pseudonym: string | null = null;
  for (let step = 0; step < maxSteps; step++) {
    options.signal?.throwIfAborted();
    const packet = await json<NextResponse>(browser, `/api/private/pseudonym-updates/${jobId}/next`);
    if (packet.job.jobId !== jobId) throw new Error("Invalid pseudonym update job");
    options.onProgress?.(packet.job);
    if (packet.operation === "complete") return true;
    if (packet.operation === "cancelled") return false;
    if (packet.operation === "commit") {
      try {
        await json(browser, `/api/private/pseudonym-updates/${jobId}/step`, "PATCH", { operation: "commit" });
        return true;
      } catch (error) {
        // A context appeared or changed between staging and commit: refetch the
        // packet and re-seal the missing context instead of failing the pass.
        if (error instanceof PseudonymChangedError) continue;
        throw error;
      }
    }
    // The staged profile ciphertext lets any enrolled device continue the same job.
    if (!packet.profile) throw new Error("Invalid pseudonym update state");
    pseudonym = (await openAccountProfile(decodeTreeBytes(packet.profile.ciphertext, MAX_ACCOUNT_PROFILE_BYTES),
      browser.vaultRootKey, { accountId: browser.accountId, epoch: packet.profile.epoch,
        revision: packet.profile.revision })).publicPseudonym;
    const contexts = packet.contexts ?? [];
    if (!contexts.length) throw new Error("Invalid pseudonym update page");
    for (const context of contexts) {
      options.signal?.throwIfAborted();
      const sealed = await sealContext(browser, context, pseudonym);
      try {
        await json(browser, `/api/private/pseudonym-updates/${jobId}/items/${context.recordId}`, "PUT", sealed);
      } catch (error) {
        // A revision or capability epoch rotated under this page; the next
        // packet reports the context again and the pass re-seals it.
        if (error instanceof PseudonymChangedError) break;
        throw error;
      }
    }
  }
  return false;
}

/** Start the one exclusive change. Cooldown is enforced server-side as well. */
export async function changePseudonym(browser: PseudonymBrowser, options: Options = {}): Promise<boolean> {
  const profile = await json<ProfileWire>(browser, "/api/private/profile");
  if (profile.nextChangeAt !== null && profile.nextChangeAt > Date.now())
    throw new PseudonymCooldownError(profile.nextChangeAt);
  const publicPseudonym = generatePseudonym();
  const sealed = await sealAccountProfile(browser.vaultRootKey, { publicPseudonym },
    { accountId: browser.accountId, epoch: profile.epoch, revision: profile.revision + 1 });
  const jobId = newOpaqueId();
  await json(browser, "/api/private/pseudonym-updates", "PUT", { jobId,
    profile: { ciphertext: encodeTreeBytes(sealed.ciphertext), epoch: sealed.epoch, revision: sealed.revision } });
  return runPseudonymUpdate(jobId, browser, options);
}

/** The current pseudonym, its cooldown and any pending update for the UI. */
export async function readPseudonymState(browser: PseudonymBrowser): Promise<PseudonymState> {
  const profile = await json<ProfileWire>(browser, "/api/private/profile");
  const opened = await openAccountProfile(decodeTreeBytes(profile.ciphertext, MAX_ACCOUNT_PROFILE_BYTES), browser.vaultRootKey,
    { accountId: browser.accountId, epoch: profile.epoch, revision: profile.revision });
  const list = await json<{ job: PseudonymJob | null }>(browser, "/api/private/pseudonym-updates");
  return { publicPseudonym: opened.publicPseudonym, nextChangeAt: profile.nextChangeAt, job: list.job };
}

export async function cancelPseudonymUpdate(browser: PseudonymBrowser, jobId: string): Promise<void> {
  await json(browser, `/api/private/pseudonym-updates/${jobId}/step`, "PATCH", { operation: "cancel" });
}

/** Production adapter: device handles and Vault keys are loaded only in the browser. */
async function productionBrowser(signal?: AbortSignal): Promise<PseudonymBrowser> {
  const browser = await loadPrivateBrowser(signal);
  return { ...browser,
    request: (path, method = "POST", body) => privateRequest(path,
      { method, signal, ...(body ? { body: JSON.stringify(body) } : {}) }) };
}

export async function loadAccountPseudonymState(signal?: AbortSignal): Promise<PseudonymState> {
  return readPseudonymState(await productionBrowser(signal));
}

export async function changeAccountPseudonym(options: Options = {}): Promise<boolean> {
  return changePseudonym(await productionBrowser(options.signal), options);
}

export async function resumeAccountPseudonymUpdate(jobId: string, options: Options = {}): Promise<boolean> {
  return runPseudonymUpdate(jobId, await productionBrowser(options.signal), options);
}

export async function cancelAccountPseudonymUpdate(jobId: string): Promise<void> {
  return cancelPseudonymUpdate(await productionBrowser(), jobId);
}
