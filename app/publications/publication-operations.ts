import type { ActivePublication, PublicationContext, PublicationOperations } from "~/shared/publications/lifecycle";
import { loadFile } from "~/shared/tree/client";
import {
  addAccountAuthor,
  addSelfAuthor,
  changeCommentAudience,
  continuePublicationTeardown,
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
 * wraps the feature-local browser client and the private tree read; the shared
 * lifecycle module never imports either.
 */
export function createPublicationOperations(): PublicationOperations {
  return {
    loadState: (context, signal) => loadPublicationState(context.fileId, signal),

    async loadActivePublication(context, signal): Promise<ActivePublication | null> {
      const file = await loadFile(context.access, context.fileId, parentKey(context), signal);
      return file.publication
        ? {
            publicationId: file.publication.publicationId,
            linkId: file.publication.linkId,
            publicKey: file.publication.publicKey,
          }
        : null;
    },

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

    async changeAudience(context, input, signal) {
      await changeCommentAudience(
        context.access,
        context.fileId,
        {
          publicationId: input.publication.publicationId,
          linkId: input.publication.linkId,
          publicKey: input.publication.publicKey,
          expectedEpochId: input.expectedEpochId,
          threadId: input.expectedThreadId,
        },
        input.audience,
        input.completeLink,
        signal,
      );
    },

    async addSelfAuthor(context, input, signal) {
      await addSelfAuthor(context.access, context.fileId, input.publication, signal);
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

    async unpublish(context, signal) {
      await unpublishPublication(context.fileId, signal);
    },

    continueTeardown: (context, signal) => continuePublicationTeardown(context.fileId, signal),
  };
}
