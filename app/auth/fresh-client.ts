import { startAuthentication } from "@simplewebauthn/browser";

import { authPost } from "./client";
import type { AssertionStart } from "./contracts";

export async function confirmFreshPasskey(signal: AbortSignal): Promise<void> {
  const start = await authPost<AssertionStart>("/api/auth/passkeys/fresh/options", {}, signal);
  const response = await startAuthentication({ optionsJSON: start.options });
  await authPost<{ ok: true }>("/api/auth/passkeys/fresh/verify",
    { challengeId: start.challengeId, response }, signal, "failed");
}
