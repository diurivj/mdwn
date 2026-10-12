import { deviceStateGeneration, deviceStateScope } from "~/shared/device/private-client";
import { privateTabMemorySuspended, registerPrivateTabMemory } from "~/shared/device/private-tab-memory";
import { listingCheckpoint } from "./listing";
import { invalidateMessage, parseTreeMessage, TREE_CHANNEL, VerifiedTreeCache } from "./verified-tree-cache";

/**
 * This tab's verified tree memory (ticket 57), tied to device state: a
 * discard of device state is a miss and a clear, and clearing private tab
 * memory clears it. It checks this browser's listing rollback checkpoints and
 * stays empty while the tab is hidden after its hidden-timeout clear. Other
 * tabs hear only id-only invalidations on `mdwn-tree`.
 */
export const treeCache = new VerifiedTreeCache({
  generation: deviceStateGeneration,
  scope: deviceStateScope,
  suspended: privateTabMemorySuspended,
  checkpoint: listingCheckpoint,
});
registerPrivateTabMemory(() => treeCache.clear());

// Only a page has other tabs to tell; Node tooling that imports this module opens no channel.
const channel =
  typeof window !== "undefined" && typeof BroadcastChannel === "function" ? new BroadcastChannel(TREE_CHANNEL) : null;
channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = parseTreeMessage(event.data);
  if (message) treeCache.invalidate(message.accountId, message.directoryIds, "remote");
});

/**
 * This tab changed (or may have changed) these Directories' listings: drop
 * them here and tell other tabs. `accountId` is the acting Account.
 */
function invalidateTreeListings(accountId: string, directoryIds: readonly string[]): void {
  treeCache.invalidate(accountId, directoryIds, "local");
  const message = invalidateMessage(accountId, directoryIds);
  if (!message) return;
  try {
    channel?.postMessage(message);
  } catch {
    // Another tab then catches up through its own background revalidation.
  }
}

/**
 * Send a change that may alter these listings. Whatever its outcome —
 * committed, refused as changed elsewhere, or unanswered — this tab and the
 * others drop what they remember of them.
 */
export async function whileChangingListings<T>(
  accountId: string,
  directoryIds: readonly string[],
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } finally {
    invalidateTreeListings(accountId, directoryIds);
  }
}
