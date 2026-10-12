import { deviceStateGeneration, deviceStateScope } from "~/shared/device/private-client";
import { clearPrivateTabMemory, registerPrivateTabMemory } from "~/shared/device/private-tab-memory";
import {
  invalidateMessage,
  parseTreeMessage,
  TREE_CHANNEL,
  type TreeMessage,
  VerifiedTreeCache,
} from "./verified-tree-cache";

/**
 * This tab's verified tree memory (ticket 57), tied to device state: a
 * discard of device state is a miss and a clear, and clearing private tab
 * memory clears it. Other tabs hear only id-only messages on `mdwn-tree`.
 */
export const treeCache = new VerifiedTreeCache({ generation: deviceStateGeneration, scope: deviceStateScope });
registerPrivateTabMemory(() => treeCache.clear());

// Only a page has other tabs to tell; Node tooling that imports this module opens no channel.
const channel =
  typeof window !== "undefined" && typeof BroadcastChannel === "function" ? new BroadcastChannel(TREE_CHANNEL) : null;
channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = parseTreeMessage(event.data);
  if (message?.type === "clear") clearPrivateTabMemory();
  else if (message) treeCache.invalidate(message.accountId, message.directoryIds, "remote");
});

function post(message: TreeMessage): void {
  try {
    channel?.postMessage(message);
  } catch {
    // Another tab then catches up through its own background revalidation.
  }
}

/**
 * This tab changed (or may have changed) these Directories' listings: drop
 * them here and tell other tabs. `accountId` is the acting Account.
 */
export function invalidateTreeListings(accountId: string, directoryIds: readonly string[]): void {
  treeCache.invalidate(accountId, directoryIds, "local");
  const message = invalidateMessage(accountId, directoryIds);
  if (message) post(message);
}

/** Forget all private tab memory here and in every other tab, as after sign-in or sign-out. */
export function clearPrivateMemoryInAllTabs(): void {
  clearPrivateTabMemory();
  post({ type: "clear" });
}
