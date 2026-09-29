import { requireSameOrigin, hasEmptyBody, MAX_AUTHENTICATED_BODY_BYTES, readAuthJsonText } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { authorizePrivateRequest } from "~/device/proof.server";
import { acceptShare, createShare, cancelShare, updateGrant, roots } from "~/sharing/lifecycle.server";
import { invitations, resolve, scope, targetContext } from "~/sharing/sharing.server";
import { isV7 } from "~/tree/wire";
import { readV2File } from "~/tree/file-v2.server";
import { bootstrapFileProvisioning, completeFileProvisioning } from "~/sharing/provisioning.server";
import { sharingBudget } from "~/sharing/budget.server";
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
  const direct = /^\/api\/private\/sharing\/direct-files\/([0-9a-f-]+)(?:\/(bootstrap|complete))?$/.exec(path);
  if (!path.startsWith("/api/private/sharing/") ||
      (share && !isV7(share[1])) || (grant && !isV7(grant[1])) || (direct && !isV7(direct[1]))) return absent();
  try { requireSameOrigin(request); } catch { return denied(); }
  let body = "", value: unknown;
  try {
    const listing = request.method === "POST" && ["invitations", "roots"].some((p) => path.endsWith(`/${p}`));
    const reading = request.method === "POST" && (listing || direct);
    if ((reading && !(listing && request.headers.has("content-type"))) || request.method === "DELETE") {
      if (!await hasEmptyBody(request)) return denied();
    } else {
      const parsed = await readAuthJsonText(request, MAX_AUTHENTICATED_BODY_BYTES);
      body = parsed.raw; value = parsed.value;
    }
  } catch { return absent(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const platform = getEnv(context);
  const measured = sharingBudget(platform.DB);
  const env = { ...platform, DB: measured.db };
  const report = async (response: Promise<Response>) => {
    const value = await response;
    // Local-only diagnostic for real SELF.fetch budgets; no query text, ID or
    // parameters in response headers, never enabled in preview/production.
    if (platform.APP_ENV === "local") value.headers.set("X-Mdwn-Sharing-Budget",
      `${measured.budget.queries};${measured.budget.maxBindings}`);
    return value;
  };
  const auth = await authorizePrivateRequest(request, env, proof, body);
  if (!auth) return denied();
  if (direct && request.method === "POST" && direct[2] === "bootstrap")
    return report(bootstrapFileProvisioning(env, auth, direct[1]!));
  if (direct && request.method === "PATCH" && direct[2] === "complete")
    return report(completeFileProvisioning(env, auth, direct[1]!, value));
  if (direct && request.method === "POST" && !direct[2]) return report(readV2File(env, auth, direct[1]!, true));
  if (path.endsWith("/scope") && request.method === "POST") return report(scope(env, auth, value));
  if (path.endsWith("/resolve") && request.method === "POST") return report(resolve(env, auth, value));
  if (path.endsWith("/target") && request.method === "POST") return report(targetContext(env, auth, value));
  if (path.endsWith("/invitations") && request.method === "POST") return report(invitations(env, auth, value));
  if (path.endsWith("/roots") && request.method === "POST") return report(roots(env, auth, value));
  if (path.endsWith("/shares") && request.method === "PUT") return report(createShare(env, auth, value));
  if (share && share[2] === "accept" && request.method === "POST") return report(acceptShare(env, auth, share[1]!, value));
  if (share && request.method === "DELETE" && share[2] !== "accept")
    return report(cancelShare(env, auth, share[1]!, share[2] === "decline"));
  if (grant && (request.method === "DELETE" || (request.method === "PATCH" && !grant[2])))
    return report(updateGrant(env, auth, grant[1]!, grant[2] === "leave", request.method, value));
  return absent();
}
