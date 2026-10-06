import { hasEmptyBody, readAuthJsonText, record, requireSameOrigin } from "~/auth/request.server";
import { getActiveSession } from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { completedRemovalRetry, deviceInventory, removeEncryptionDevice } from "~/device/management.server";
import { authorizeDeviceForSession } from "~/device/proof.server";

import type { Route } from "./+types/private-devices";

const noStore = { "Cache-Control": "no-store" };
const denied = (status = 403) => Response.json({ error: "device_proof_required" }, { status, headers: noStore });

/** Private data stays in an action response, never a document loader or SSR payload. */
export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  if (request.method !== "POST") return denied(405);
  try {
    requireSameOrigin(request);
  } catch {
    return denied();
  }
  const path = new URL(request.url).pathname;
  if (path !== "/api/private/devices/inventory" && path !== "/api/private/devices/remove") return denied(404);
  try {
    const inventory = path.endsWith("/inventory");
    let raw = "";
    let value: Record<string, unknown> | null = null;
    if (inventory) {
      if (!(await hasEmptyBody(request))) return denied();
    } else {
      const parsed = await readAuthJsonText(request);
      raw = parsed.raw;
      value = record(parsed.value);
    }
    const proof = JSON.parse(request.headers.get("X-Mdwn-Device-Proof") ?? "null") as unknown;
    const env = getEnv(context);
    const session = await getActiveSession(request, env);
    if (!session || session.purpose !== "normal") return denied(401);
    const authorized = await authorizeDeviceForSession(env, session, request, proof, raw);
    if (!authorized) {
      if (!inventory && (await completedRemovalRetry(env, session, request, proof, raw, value))) {
        return Response.json({ ok: true, alreadyRemoved: true }, { headers: noStore });
      }
      return denied();
    }
    return inventory ? deviceInventory(env, authorized) : removeEncryptionDevice(env, session, authorized, value);
  } catch {
    return denied();
  }
}
