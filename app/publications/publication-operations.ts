import type { PublicationContext, PublicationOperations } from "~/shared/publications/lifecycle";
import {
  continuePublicationTeardown,
  loadPublicationState,
  publishFile,
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
 * wraps the feature-local browser client; the shared lifecycle module never
 * imports it.
 */
export function createPublicationOperations(): PublicationOperations {
  return {
    loadState: (context, signal) => loadPublicationState(context.fileId, signal),

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
  };
}
