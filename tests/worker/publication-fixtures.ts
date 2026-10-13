import { SELF } from "cloudflare:test";
import {
  sealCommentEpochLink,
  sealPublicAttribution,
  sealPublicCommentBody,
} from "../../app/shared/comments/public-content";
import { generateVaultRootKey, sealVaultRecoveryEnvelope } from "../../app/shared/crypto/vault";
import {
  createPublicationKeyPair,
  formatPublicationFragment,
  newPublicationIdentifier,
  ownerLinkContext,
} from "../../app/shared/publications/capability";
import { publicPresentation, sealPublicRepresentation } from "../../app/shared/publications/content";
import { encodeTreeBytes } from "../../app/shared/tree/wire";
import { opaqueId, sharingRequest, type SharingAccount } from "./sharing-fixtures";

/**
 * Browser-half Publication fixtures shared by the Worker/D1 suites: they drive
 * the real protocol through the Worker routes, sealing link wrappers, recovery
 * envelopes and Comment bodies exactly as the client would. No private key,
 * fragment or plaintext reaches D1.
 */

export type FileView = { revision: number; representationId: string };

export async function fileView(actor: SharingAccount, fileId: string): Promise<FileView> {
  const response = await sharingRequest(actor, `/api/private/tree/files/${fileId}`);
  if (!response.ok) throw new Error(`file read failed: ${response.status}`);
  return response.json() as Promise<FileView>;
}

export type Epoch = {
  threadId: string;
  epochId: string;
  capabilityId: string;
  capability: Uint8Array<ArrayBuffer>;
  audience: "public" | "collaborators_only";
  vaultRootKey: Uint8Array;
};

export type Publication = {
  publicationId: string;
  linkId: string;
  linkKey: Awaited<ReturnType<typeof createPublicationKeyPair>>;
  fragment: string;
  epoch: Epoch;
  /** The Owner link copy sent with the link, sealed under `epoch.vaultRootKey`. */
  ownerLink: string;
};

/**
 * The Owner link copy (ticket 68) as the Owner's browser seals it: the link's
 * private scalar under the Owner's Vault root key, bound to this exact
 * Publication and path. `context` lets a test mis-bind it.
 */
export async function ownerLinkCopy(
  ownerId: string,
  link: { publicationId: string; linkId: string },
  privateKey: Uint8Array,
  vaultRootKey: Uint8Array,
  context = ownerLinkContext(ownerId, link.publicationId, link.linkId),
): Promise<string> {
  return encodeTreeBytes(
    await sealVaultRecoveryEnvelope(
      vaultRootKey,
      { scope: "owned", objectId: context.objectId, keyId: context.keyId, key: privateKey },
      context,
    ),
  );
}

/** One fully sealed creation request, built but not yet sent. */
export type PublicationCreation = Publication & { body: Record<string, unknown> };

/** The Owner's browser half of publishing with its first audience epoch. */
export async function publicationCreation(
  owner: SharingAccount,
  fileId: string,
  audience: "public" | "collaborators_only" = "public",
  recovery = generateVaultRootKey(),
): Promise<PublicationCreation> {
  const current = await fileView(owner, fileId);
  const linkKey = await createPublicationKeyPair();
  const publicationId = newPublicationIdentifier(),
    linkId = newPublicationIdentifier();
  const built = await firstEpoch(owner, publicationId, linkId, linkKey, audience, recovery);
  const representation = await sealPublicRepresentation(
    { publicationId, linkId, publicKey: linkKey.publicKey, revision: 1 },
    publicPresentation("# Public body"),
  );
  const ownerLink = await ownerLinkCopy(owner.accountId, { publicationId, linkId }, linkKey.privateKey, recovery);
  return {
    publicationId,
    linkId,
    linkKey,
    fragment: formatPublicationFragment(linkKey.privateKey),
    ownerLink,
    epoch: {
      threadId: built.threadId,
      epochId: built.epochId,
      capabilityId: built.capabilityId,
      capability: built.capability,
      audience,
      vaultRootKey: recovery,
    },
    body: {
      publicationId,
      linkId,
      publicKey: encodeTreeBytes(linkKey.publicKey),
      expectedRevision: current.revision,
      expectedRepresentationId: current.representationId,
      representation: { ciphertext: encodeTreeBytes(representation) },
      author: null,
      comments: {
        threadId: built.threadId,
        epochId: built.epochId,
        capabilityId: built.capabilityId,
        audience,
        recoveryEnvelope: encodeTreeBytes(built.recoveryEnvelope),
        linkWrapper: built.linkWrapper ? encodeTreeBytes(built.linkWrapper) : null,
      },
      ownerLink,
    },
  };
}

export async function publish(
  owner: SharingAccount,
  fileId: string,
  audience: "public" | "collaborators_only" = "public",
  recovery = generateVaultRootKey(),
): Promise<Publication> {
  const creation = await publicationCreation(owner, fileId, audience, recovery);
  const response = await sharingRequest(owner, `/api/private/publications/files/${fileId}`, "PUT", creation.body);
  if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
  return {
    publicationId: creation.publicationId,
    linkId: creation.linkId,
    linkKey: creation.linkKey,
    fragment: creation.fragment,
    epoch: creation.epoch,
    ownerLink: creation.ownerLink,
  };
}

export async function firstEpoch(
  owner: SharingAccount,
  publicationId: string,
  linkId: string,
  linkKey: Awaited<ReturnType<typeof createPublicationKeyPair>>,
  audience: "public" | "collaborators_only",
  vaultRootKey: Uint8Array,
  threadId = opaqueId(),
) {
  const epochId = opaqueId(),
    capabilityId = opaqueId();
  const capability = crypto.getRandomValues(new Uint8Array(32));
  const recoveryEnvelope = await sealVaultRecoveryEnvelope(
    vaultRootKey,
    { scope: "owned", objectId: epochId, keyId: capabilityId, key: capability },
    {
      purpose: "vault-recovery",
      vaultId: owner.accountId,
      objectId: epochId,
      keyId: capabilityId,
      keyEpoch: 1,
      revision: 1,
    },
  );
  const linkWrapper =
    audience === "public"
      ? await sealCommentEpochLink(linkKey.privateKey, linkKey.publicKey, {
          publicationId,
          linkId,
          epochId,
          capabilityId,
          keyEpoch: 1,
          capability,
        })
      : null;
  return { threadId, epochId, capabilityId, capability, recoveryEnvelope, linkWrapper };
}

/**
 * The Owner's browser half of link rotation (ticket 25): a fresh path/key pair,
 * the re-encrypted current representation, every public epoch rewrapped to
 * the new capability and the new link's Owner link copy. Built but not sent,
 * so a caller can assert a denial.
 */
export async function rotationPayload(
  owner: SharingAccount,
  fileId: string,
  publication: Publication,
  markdown = "# Public body",
) {
  const response = await sharingRequest(owner, `/api/private/tree/files/${fileId}`);
  if (!response.ok) throw new Error(`file read failed: ${response.status}`);
  const current = (await response.json()) as FileView & { publication: { revision: number; linkId: string } | null };
  if (!current.publication) throw new Error("no active publication");
  const linkKey = await createPublicationKeyPair(),
    linkId = newPublicationIdentifier();
  const revision = current.publication.revision;
  const ciphertext = await sealPublicRepresentation(
    { publicationId: publication.publicationId, linkId, publicKey: linkKey.publicKey, revision },
    publicPresentation(markdown),
  );
  const wrapper = encodeTreeBytes(
    await sealCommentEpochLink(linkKey.privateKey, linkKey.publicKey, {
      publicationId: publication.publicationId,
      linkId,
      epochId: publication.epoch.epochId,
      capabilityId: publication.epoch.capabilityId,
      keyEpoch: 1,
      capability: publication.epoch.capability,
    }),
  );
  return {
    publicationId: publication.publicationId,
    linkId,
    publicKey: encodeTreeBytes(linkKey.publicKey),
    expectedLinkId: current.publication.linkId,
    expectedPresentationRevision: revision,
    expectedRevision: current.revision,
    expectedRepresentationId: current.representationId,
    representation: { ciphertext: encodeTreeBytes(ciphertext) },
    epochs: [
      { epochId: publication.epoch.epochId, capabilityId: publication.epoch.capabilityId, keyEpoch: 1, wrapper },
    ],
    ownerLink: await ownerLinkCopy(
      owner.accountId,
      { publicationId: publication.publicationId, linkId },
      linkKey.privateKey,
      publication.epoch.vaultRootKey,
    ),
  };
}

export function sealedComment(publication: Publication, text: string, revision = 1, epoch = publication.epoch) {
  const commentId = opaqueId();
  return sealPublicCommentBody(epoch.capability, {
    publicationId: publication.publicationId,
    commentId,
    capabilityId: epoch.capabilityId,
    keyEpoch: 1,
    revision,
    text,
  }).then((sealed) => ({ commentId, ...sealed }));
}

export function sealedAttribution(publication: Publication, pseudonym: string) {
  const attributionId = opaqueId();
  return sealPublicAttribution(publication.epoch.capability, {
    publicationId: publication.publicationId,
    attributionId,
    pseudonym,
    capabilityId: publication.epoch.capabilityId,
    keyEpoch: 1,
  });
}

export function commentPayload(
  publication: Publication,
  comment: { commentId: string; bodyCiphertext: string; contentKeyEnvelope: string },
  attribution: { attributionId: string; ciphertext: string; contentKeyEnvelope: string } | null = null,
) {
  return {
    commentId: comment.commentId,
    threadId: publication.epoch.threadId,
    epochId: publication.epoch.epochId,
    capabilityId: publication.epoch.capabilityId,
    capabilityEpoch: 1,
    bodyCiphertext: comment.bodyCiphertext,
    contentKeyEnvelope: comment.contentKeyEnvelope,
    attribution,
  };
}

export type AnonymousComments = {
  audience: string;
  threadId: string | null;
  epochs: { epochId: string; capabilityId: string; capabilityEpoch: number; wrapper: string }[];
  comments: {
    id: string;
    epochId: string;
    authorId: string;
    sequence: number;
    revision: number;
    bodyCiphertext: string;
    contentKeyEnvelope: string;
    contentKeyEpoch: number;
  }[];
  attributions: {
    id: string;
    authorId: string;
    epochId: string;
    revision: number;
    ciphertext: string;
    contentKeyEnvelope: string;
  }[];
  nextCursor: number | null;
};

/** Anonymous link read used to prove no ciphertext leaves a denied surface. */
export async function anonymousComments(linkId: string): Promise<AnonymousComments> {
  const response = await SELF.fetch(`https://mdwn.test/api/public/publications/${linkId}`);
  if (response.status !== 200) throw new Error(`anonymous read failed: ${response.status}`);
  return ((await response.json()) as { comments: AnonymousComments }).comments;
}
