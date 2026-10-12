import { listRelationships, type ReceivedGrant } from "./relationships-client";

/** What the library sidebar shows: received Grant roots and the pending invitation count. */
export type SharedWithMe = { accountId: string; received: ReceivedGrant[]; invitations: number };

/**
 * Tab memory for the library sidebar's **Shared with me** section. Files
 * routes remount on navigation; a short-lived in-memory summary keeps that
 * from sending relationship lists on every visit. Nothing is stored: a new
 * document starts empty, and an entry serves only the Account it was read for.
 */
export function createSharedWithMeCache({
  load,
  now = Date.now,
  lifetime = 60_000,
}: {
  load: () => Promise<SharedWithMe>;
  now?: () => number;
  lifetime?: number;
}) {
  let entry: { value: SharedWithMe; at: number } | null = null;
  let inflight: { accountId: string; promise: Promise<SharedWithMe> } | null = null;
  // Each invalidation starts a generation; an older read is returned but never stored.
  let generation = 0;

  return {
    peek(accountId: string): SharedWithMe | null {
      return entry?.value.accountId === accountId ? entry.value : null;
    },
    read(accountId: string, { maxAge = lifetime }: { maxAge?: number } = {}): Promise<SharedWithMe> {
      if (entry?.value.accountId === accountId && now() - entry.at < Math.min(maxAge, lifetime))
        return Promise.resolve(entry.value);
      if (inflight?.accountId === accountId) return inflight.promise;
      const started = generation;
      const promise = load()
        .then((value) => {
          if (value.accountId !== accountId) throw new Error("Shared with me changed Account");
          if (started === generation) entry = { value, at: now() };
          return value;
        })
        .finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });
      inflight = { accountId, promise };
      return promise;
    },
    prime(value: SharedWithMe) {
      generation += 1;
      inflight = null;
      entry = { value, at: now() };
    },
    invalidate() {
      generation += 1;
      inflight = null;
      entry = null;
    },
  };
}

async function loadSharedWithMe(): Promise<SharedWithMe> {
  const relationships = await listRelationships();
  return {
    accountId: relationships.accountId,
    received: relationships.received,
    invitations: relationships.incoming.length,
  };
}

/** The one tab-wide instance; sharing actions call `invalidate` or `prime`. */
export const sharedWithMe = createSharedWithMeCache({ load: loadSharedWithMe });
