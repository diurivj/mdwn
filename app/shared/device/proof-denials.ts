/**
 * The proof-denial codes a private route answers with `403` (ticket 57),
 * shared by the Worker, which sends them, and the browser, which decides on
 * them.
 *
 * - `DEVICE_PROOF_REQUIRED`: the proof did not authorize this request, and
 *   this request committed nothing. Sent when verification fails, and also
 *   after a guarded commit that changed nothing. One retry signed with
 *   demonstrably different device state therefore cannot apply a change twice.
 * - `DEVICE_PROOF_SPENT`: after a failed or uncertain commit, the proof is
 *   expired or already used, so an earlier use, or this very request, may
 *   have committed. Never retried.
 */
export const DEVICE_PROOF_REQUIRED = "device_proof_required";
export const DEVICE_PROOF_SPENT = "device_proof_spent";
