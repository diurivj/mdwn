import { PublicationError, type PublicationContext, type PublicationOperations } from "~/shared/publications/lifecycle";
import { loadFile } from "~/shared/tree/client";
import {
  addAccountAuthor,
  addSelfAuthor,
  changeCommentAudience,
  continuePublicationTeardown,
  declarePublicationAuthor,
  loadPublicationState,
  publishFile,
  removeAuthor,
  removePublicationRequest,
  requestPublication,
  rotatePublicationLink,
  unpublishPublication,
} from "./publications-client";

/** The parent key is required for every capability-bearing operation; the
 * panel disables those decisions until the File's private tree is available. */
function parentKey(context: PublicationContext): Uint8Array {
  if (!context.parentKey) throw new Error("private tree unavailable");
  return context.parentKey;
}

/**
 * Production implementation of the lifecycle's internal operations seam. It
 * wraps the feature-local browser client and reuses its cryptographic and
 * business-rule operations unchanged; the shared lifecycle module never
 * imports it.
 */
export function createPublicationOperations(): PublicationOperations {
  return {
    loadState: (context, signal) => loadPublicationState(context.access, context.fileId, signal),

    async publish(context, input, signal) {
      await publishFile({
        access: context.access,
        fileId: context.fileId,
        parentId: context.parentId,
        parentKey: parentKey(context),
        includeSelf: input.includeSelf,
        audience: input.audience,
        signal,
        onPrepared: input.onPrepared,
      });
    },

    async rotateLink(context, input, signal) {
      await rotatePublicationLink({
        access: context.access,
        fileId: context.fileId,
        parentKey: parentKey(context),
        signal,
        onPrepared: input.onPrepared,
      });
    },

    async unpublish(context, signal) {
      await unpublishPublication(context.fileId, signal);
    },

    continueTeardown: (context, signal) => continuePublicationTeardown(context.fileId, signal),

    async changeAudience(context, input, signal) {
      const file = await loadFile(context.access, context.fileId, parentKey(context), signal);
      if (!file.publication || file.publication.publicationId !== input.expectedPublicationId)
        throw new PublicationError("changed");
      await changeCommentAudience(
        context.access,
        context.fileId,
        {
          publicationId: file.publication.publicationId,
          linkId: file.publication.linkId,
          publicKey: file.publication.publicKey,
          expectedEpochId: input.expectedEpochId,
          threadId: input.threadId,
        },
        input.audience,
        input.linkFor(file.publication.linkId),
        signal,
      );
    },

    async addSelfAuthor(context, signal) {
      const file = await loadFile(context.access, context.fileId, parentKey(context), signal);
      if (!file.publication) throw new PublicationError("changed");
      await addSelfAuthor(context.access, context.fileId, file.publication, signal);
    },

    async declareSelfAuthor(context, signal) {
      const file = await loadFile(context.access, context.fileId, parentKey(context), signal);
      if (!file.publication) throw new PublicationError("changed");
      await declarePublicationAuthor(context.access, context.fileId, file.publication, signal);
    },

    async addAccountAuthor(context, input, signal) {
      await addAccountAuthor(context.fileId, input.publicationId, input.address, signal);
    },

    async removeAuthor(context, input, signal) {
      await removeAuthor(context.fileId, input.declarationId, signal);
    },

    async requestPublication(context, signal) {
      await requestPublication(context.fileId, signal);
    },

    async removePublicationRequest(context, input, signal) {
      await removePublicationRequest(context.fileId, input.requestId, signal);
    },
  };
}
