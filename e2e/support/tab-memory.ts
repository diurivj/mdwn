import type { Page } from "@playwright/test";

/**
 * Make this page forget its private tab memory (ticket 57), as another tab's
 * sign-in or sign-out does, so its next Files navigation walks the network
 * again. A second channel object in the same page receives the message.
 */
export async function forgetTabMemory(page: Page) {
  await page.evaluate(() => {
    const channel = new BroadcastChannel("mdwn-tree");
    channel.postMessage({ type: "clear" });
    channel.close();
  });
}

/**
 * From its next navigation, this page neither posts nor hears tab-memory
 * messages: its changes reach other tabs as another device's or
 * Collaborator's would, through their background revalidation only.
 */
export async function withoutTabMessages(page: Page) {
  await page.addInitScript(() => {
    class SilentChannel extends EventTarget {
      onmessage = null;
      postMessage() {}
      close() {}
    }
    Object.assign(window, { BroadcastChannel: SilentChannel });
  });
}
