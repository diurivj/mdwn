import { hasEmptyBody, readAuthJsonText, requireSameOrigin } from "~/auth/request.server";
import { createPrivateComment, createPrivateThread, deletePrivateComment, editPrivateComment,
  provisionThreadDevices, readPrivateThread, readThreadKey } from "~/comments/comments.server";
import { getEnv } from "~/context/env";
import { authorizePrivateRequest } from "~/device/proof.server";
import { sharingBudget } from "~/sharing/budget.server";
import { isV7 } from "~/tree/wire";
import type { Route } from "./+types/private-comments";

const noStore = { "Cache-Control": "no-store" };
const denied = () => Response.json({ error: "device_proof_required" }, { status: 403, headers: noStore });
const absent = () => Response.json({ error: "not_found" }, { status: 404, headers: noStore });

/** Resource-only Private Comment API; private data never enters a loader or SSR payload. */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  const path = new URL(request.url).pathname;
  const file = /^\/api\/private\/comments\/files\/([0-9a-f-]+)(?:\/(thread|thread\/devices|comments))?$/.exec(path);
  const item = /^\/api\/private\/comments\/comments\/([0-9a-f-]+)$/.exec(path);
  const id = (file ?? item)?.[1];
  const method = request.method;
  const route = file && !file[2] && method === "POST" ? "read" :
    file?.[2] === "thread" && method === "PUT" ? "create-thread" :
    file?.[2] === "thread" && method === "POST" ? "thread-key" :
    file?.[2] === "thread/devices" && method === "PATCH" ? "provision" :
    file?.[2] === "comments" && method === "PUT" ? "create" :
    item && method === "PATCH" ? "edit" : item && method === "DELETE" ? "delete" : null;
  if (!route || !isV7(id)) return absent();
  try { requireSameOrigin(request); } catch { return denied(); }
  let body = "", value: unknown;
  try {
    // A thread read may carry a JSON cursor; deletion, key reads and a first-page read have no body.
    if (route === "delete" || route === "thread-key" || (route === "read" && !request.headers.has("content-type"))) {
      if (!await hasEmptyBody(request)) return denied();
    } else {
      const parsed = await readAuthJsonText(request, 1024 * 1024);
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
  const response = await (route === "read" ? readPrivateThread(env, auth, id, value) :
    route === "create-thread" ? createPrivateThread(env, auth, id, value) :
    route === "thread-key" ? readThreadKey(env, auth, id) :
    route === "provision" ? provisionThreadDevices(env, auth, id, value) :
    route === "create" ? createPrivateComment(env, auth, id, value) :
    route === "edit" ? editPrivateComment(env, auth, id, value) : deletePrivateComment(env, auth, id));
  // Local-only query-budget diagnostic, never emitted in preview or production.
  if (platform.APP_ENV === "local") response.headers.set("X-Mdwn-Sharing-Budget",
    `${measured.budget.queries};${measured.budget.maxBindings}`);
  return response;
}
