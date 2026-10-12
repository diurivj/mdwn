import { clearPrivateMemoryInAllTabs } from "~/shared/device/private-tab-memory";
import { isV7 } from "~/shared/tree/wire";
import { acceptShare, cancelShare, changeGrant, declineShare, leaveGrant, revokeGrant } from "./relationships-client";
import { type SharingFailure, sharingFailure } from "./sharing-errors";
import { sharedWithMe } from "./shared-with-me-cache";

/**
 * The Sharing page's explicit form intents. Each runs one proof-guarded
 * relationship request; the route's revalidation then reloads the lists.
 * Another surface (a workspace Share dialog) can submit the same intents.
 */
export const SHARING_INTENTS = [
  "accept",
  "decline",
  "cancel",
  "leave",
  "revoke",
  "permission",
  "set-expiry",
  "clear-expiry",
] as const;
export type SharingIntent = (typeof SHARING_INTENTS)[number];

export type SharingOutcome = {
  intent: SharingIntent | null;
  state: "done" | "invalid" | SharingFailure;
};

/**
 * A chosen calendar date (`YYYY-MM-DD`) ends at the close of that local day.
 * Returns null for anything that is not a real date strictly after `now`.
 */
export function expiryFromDate(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== day) return null;
  const at = end.getTime();
  return Number.isSafeInteger(at) && at > now ? at : null;
}

function revision(value: FormDataEntryValue | null): number | null {
  const parsed = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export async function runSharingIntent(form: FormData, signal: AbortSignal): Promise<SharingOutcome> {
  const raw = form.get("intent");
  const intent = SHARING_INTENTS.find((item) => item === raw) ?? null;
  const id = form.get("id");
  if (!intent || !isV7(id)) return { intent, state: "invalid" };
  const expected = revision(form.get("revision"));
  try {
    switch (intent) {
      case "accept":
        await acceptShare(id, signal);
        break;
      case "decline":
        await declineShare(id, signal);
        break;
      case "cancel":
        await cancelShare(id, signal);
        break;
      case "leave":
      case "revoke":
        if (expected === null) return { intent, state: "invalid" };
        await (intent === "leave" ? leaveGrant : revokeGrant)(id, expected, signal);
        break;
      case "permission": {
        const permission = form.get("permission");
        if (expected === null || (permission !== "read_only" && permission !== "read_write"))
          return { intent, state: "invalid" };
        await changeGrant(id, expected, { permission }, signal);
        break;
      }
      case "set-expiry":
      case "clear-expiry": {
        const expiresAt = intent === "clear-expiry" ? null : expiryFromDate(form.get("expiresOn"));
        if (expected === null || (intent === "set-expiry" && expiresAt === null)) return { intent, state: "invalid" };
        await changeGrant(id, expected, { expiresAt }, signal);
        break;
      }
    }
    return { intent, state: "done" };
  } catch (error) {
    if (signal.aborted) throw error;
    return { intent, state: sharingFailure(error) };
  } finally {
    // Whatever happened, the library sidebar's remembered summary may be stale.
    sharedWithMe.invalidate();
    // Leaving may have ended this Account's access to a Grant root that tab
    // memory still holds verified listings and keys for (ticket 57).
    if (intent === "leave") clearPrivateMemoryInAllTabs();
  }
}
