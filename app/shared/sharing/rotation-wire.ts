import type { FileCapability } from "~/shared/tree/file-capability-client";
import type { FileHead } from "~/shared/tree/file-head";
import type { SealedEntry, ListingHead } from "~/shared/tree/listing";

export type RotationJob = {
  jobId: string;
  targetId: string;
  keyEpoch: number;
  state: "pending" | "complete" | "cancelled";
  progress: number;
  runnable?: boolean;
};
export type RotationItem = {
  objectId: string;
  kind: "directory" | "file" | "private_comment" | "public_history";
  fileId: string | null;
  depth: number;
  state: "ready" | "staging" | "complete";
  sourceEpoch: number | null;
  targetEpoch: number | null;
  capabilityId: string | null;
  sourceRevision: number | null;
  sourceRepresentationId: string | null;
  resumeEnvelope: string | null;
  cursor: string | null;
  /** A current Collaborators-only Public Comment audience epoch: its
   * capability advances in place because a revoked device may still hold the
   * old epoch key. A retained (or public) epoch keeps its key and only renews
   * envelopes. The persisted `public_history` kind names any Public Comment
   * audience epoch item from the ticket 18/20 registry. */
  rotate: boolean;
};
export type RotationListingHead = ListingHead & { signerDeviceId: string; signerPublicKey: string };
export type RotationDirectory = {
  kind: "directory";
  objectId: string;
  parentId: string | null;
  keyEpoch: number;
  entriesRevision: number;
  listingHead: RotationListingHead | null;
};
/** An imported Historical thread whose envelope is wrapped under its File's
 * capability key. The File replacement re-wraps each one before its own
 * capability is replaced, so the thread stays readable and can then rotate. */
export type RotationImportedThread = {
  threadId: string;
  capabilityId: string;
  capabilityEpoch: number;
  envelope: string;
};
export type RotationFile = {
  kind: "file";
  objectId: string;
  parentId: string;
  capability: FileCapability | null;
  revision: number;
  representationId: string;
  contentKeyId: string;
  keyEpoch: number;
  ciphertext: string;
  keyEnvelope: string;
  representationKeyEnvelope: string | null;
  fileHead: (FileHead & { signerDeviceId: string; signerPublicKey: string }) | null;
  importedThreads: RotationImportedThread[];
};
export type RotationComment = ({ kind: "private_comment" } | { kind: "public_history" }) & {
  objectId: string;
  fileId: string;
  capabilityId: string;
  capabilityEpoch: number;
  purpose: "private-comment-thread" | "public-comment-audience-epoch";
  threadId: string;
  publicationId: string | null;
  recoveryEnvelope: string | null;
  /** An imported Historical thread's envelope under the current File capability key; null for owned threads. */
  importEnvelope: string | null;
};
export type RotationSource = RotationDirectory | RotationFile | RotationComment;
export type RotationNext = {
  job: RotationJob;
  operation: "start" | "stage" | "promote" | "deliver" | "finish" | "complete" | "restart" | "advance";
  item?: RotationItem;
  source?: RotationSource;
  grantId?: string;
  commentObjectId?: string;
};
export type RotationEntries = { entries: SealedEntry[]; nextCursor: string | null };

/** Installed ciphertext versions are distinct from the job's authorization fence. */
export function rotationSourceVersion(source: RotationSource) {
  if (source.kind === "directory") return { epoch: source.keyEpoch, revision: source.entriesRevision };
  if (source.kind === "file") return { epoch: source.capability?.epoch ?? 0, revision: source.revision };
  return { epoch: source.capabilityEpoch, revision: source.capabilityEpoch };
}

/** Explicitly job-bound Owner-only resume envelope, not an ordinary recovery source. */
export function rotationResumeContext(accountId: string, jobId: string, objectId: string, epoch: number) {
  return {
    purpose: "vault-recovery" as const,
    vaultId: accountId,
    objectId: jobId,
    keyId: objectId,
    keyEpoch: epoch,
    revision: 1,
  };
}
