import { deviceStateGeneration } from "./private-client";

/** Background upkeep starts at most this often per tab (ticket 57). */
const UPKEEP_INTERVAL_MS = 60_000;

/**
 * "At most once a minute per tab" for one kind of background upkeep, with the
 * last status it reported. Memory only, never persisted. Both reset whenever
 * device state is discarded (sign-in, sign-out, recovery, enrollment, a `401`,
 * an Account or device change, or any clear of private tab memory), so one
 * Session's throttle or status never carries into the next.
 */
export function createUpkeepThrottle<Status>(intervalMs = UPKEEP_INTERVAL_MS) {
  let started: { at: number; generation: number } | null = null;
  let last: Status | undefined;
  const current = () => started !== null && started.generation === deviceStateGeneration();
  return {
    /** Whether upkeep may start now. */
    due(): boolean {
      if (!current()) return true;
      const age = Date.now() - started!.at;
      return age < 0 || age >= intervalMs;
    },
    /** Record that upkeep starts now; the previous status no longer applies. */
    start(): void {
      started = { at: Date.now(), generation: deviceStateGeneration() };
      last = undefined;
    },
    /** Remember what the upkeep started last reported, unless state was discarded since. */
    remember(status: Status): void {
      if (current()) last = status;
    },
    /** The last remembered status for the current device state, if any. */
    status(): Status | undefined {
      return current() ? last : undefined;
    },
  };
}
