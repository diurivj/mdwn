import { hasEmptyBody, requireSameOrigin } from "~/auth/request.server";
import { readEncryptedProfile } from "~/account/profile.server";
import { getEnv } from "~/context/env";
import { authorizePrivateRequest } from "~/device/proof.server";

import type { Route } from "./+types/private-profile";

const headers = { "Cache-Control": "no-store" };
const denied = (status = 403) => Response.json({ error: "device_proof_required" }, { status, headers });

/** A private profile read is a proof-guarded, bodyless POST and never SSR data. */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).search) return denied(404);
  try { requireSameOrigin(request); } catch { return denied(); }
  try { if (!await hasEmptyBody(request)) return denied(); } catch { return denied(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const env = getEnv(context);
  const auth = await authorizePrivateRequest(request, env, proof);
  if (!auth) return denied();
  return readEncryptedProfile(env, auth);
}
