import { requireSameOrigin, hasEmptyBody, readAuthJsonText } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { authorizePrivateRequest } from "~/device/proof.server";
import { acceptShare, createShare, cancelShare, updateGrant, roots } from "~/sharing/lifecycle.server";
import { invitations, resolve, scope, targetContext } from "~/sharing/sharing.server";
import { isV7 } from "~/tree/wire";
import { readV2File } from "~/tree/file-v2.server";
import type { Route } from "./+types/private-sharing";

const denied = () => Response.json({ error: "device_proof_required" }, { status: 403,
  headers: { "Cache-Control": "no-store" } });
const absent = () => Response.json({ error: "not_found" }, { status: 404,
  headers: { "Cache-Control": "no-store" } });

/** Resource-only Worker action. Private data never enters a server loader or SSR. */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  const path = new URL(request.url).pathname;
  const share = /^\/api\/private\/sharing\/shares\/([0-9a-f-]+)(?:\/(accept|decline))?$/.exec(path);
  const grant = /^\/api\/private\/sharing\/grants\/([0-9a-f-]+)(?:\/(leave))?$/.exec(path);
  const direct = /^\/api\/private\/sharing\/direct-files\/([0-9a-f-]+)$/.exec(path);
  if (!path.startsWith("/api/private/sharing/") ||
      (share && !isV7(share[1])) || (grant && !isV7(grant[1])) || (direct && !isV7(direct[1]))) return absent();
  try { requireSameOrigin(request); } catch { return denied(); }
  let body = "", value: unknown;
  try {
    const reading = request.method === "POST" && (["invitations", "roots"].some((p) => path.endsWith(`/${p}`)) || direct);
    if (reading || request.method === "DELETE") {
      if (!await hasEmptyBody(request)) return denied();
    } else {
      const parsed = await readAuthJsonText(request, 1536 * 1024);
      body = parsed.raw; value = parsed.value;
    }
  } catch { return absent(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const env = getEnv(context);
  const auth = await authorizePrivateRequest(request, env, proof, body);
  if (!auth) return denied();
  if (direct && request.method === "POST") return readV2File(env, auth, direct[1]!, true);
  if (path.endsWith("/scope") && request.method === "POST") return scope(env, auth, value);
  if (path.endsWith("/resolve") && request.method === "POST") return resolve(env, auth, value);
  if (path.endsWith("/target") && request.method === "POST") return targetContext(env, auth, value);
  if (path.endsWith("/invitations") && request.method === "POST") return invitations(env, auth);
  if (path.endsWith("/roots") && request.method === "POST") return roots(env, auth);
  if (path.endsWith("/shares") && request.method === "PUT") return createShare(env, auth, value);
  if (share && share[2] === "accept" && request.method === "POST") return acceptShare(env, auth, share[1]!, value);
  if (share && request.method === "DELETE") return cancelShare(env, auth, share[1]!, share[2] === "decline");
  if (grant && (request.method === "DELETE" || request.method === "PATCH"))
    return updateGrant(env, auth, grant[1]!, grant[2] === "leave", request.method, value);
  return absent();
}
