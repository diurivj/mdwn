import { hasEmptyBody, readAuthJsonText, requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { authorizePrivateRequest } from "~/device/proof.server";
import { sharingBudget } from "~/sharing/budget.server";
import { listRotations, nextRotationStep, resealDirectoryGrants, rotateFileTarget } from "~/sharing/rotation.server";
import { isV7 } from "~/tree/wire";
import type { Route } from "./+types/private-rotations";

const noStore = { "Cache-Control": "no-store" };
const denied = () => Response.json({ error: "device_proof_required" }, { status: 403, headers: noStore });
const absent = () => Response.json({ error: "not_found" }, { status: 404, headers: noStore });
/**
 * The shared authenticated-body ceiling. A Directory rekey step carries its re-sealed entries and
 * two signed listings, so a Directory whose listing nears the 512 KiB cap cannot rotate in one step.
 */
const MAX_STEP_BYTES = 1536 * 1024;

/** Resource-only Owner rotation API (ticket 19); private data never enters a loader or SSR payload. */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  const path = new URL(request.url).pathname;
  const target = /^\/api\/private\/rotations\/([0-9a-f-]+)\/(next|file|grants)$/.exec(path);
  const method = request.method;
  const route = path === "/api/private/rotations" && method === "POST" ? "list" :
    target?.[2] === "next" && method === "POST" ? "next" :
    target?.[2] === "file" && method === "PATCH" ? "file" :
    target?.[2] === "grants" && method === "PATCH" ? "grants" : null;
  if (!route || (target && !isV7(target[1]))) return absent();
  try { requireSameOrigin(request); } catch { return denied(); }
  let body = "", value: unknown;
  try {
    if (route === "list" || route === "next") {
      if (!await hasEmptyBody(request)) return denied();
    } else {
      const parsed = await readAuthJsonText(request, MAX_STEP_BYTES);
      body = parsed.raw; value = parsed.value;
    }
  } catch { return absent(); }
  let proof: unknown;
  try { proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null"); }
  catch { return denied(); }
  const platform = getEnv(context);
  const measured = sharingBudget(platform.DB);
  const env = { ...platform, DB: measured.db };
  const auth = await authorizePrivateRequest(request, env, proof, body);
  if (!auth) return denied();
  const id = target?.[1] ?? "";
  const response = await (route === "list" ? listRotations(env, auth) :
    route === "next" ? nextRotationStep(env, auth, id) :
    route === "file" ? rotateFileTarget(env, auth, id, value) : resealDirectoryGrants(env, auth, id, value));
  // Local-only query-budget diagnostic, never emitted in preview or production.
  if (platform.APP_ENV === "local") response.headers.set("X-Mdwn-Sharing-Budget",
    `${measured.budget.queries};${measured.budget.maxBindings}`);
  return response;
}
