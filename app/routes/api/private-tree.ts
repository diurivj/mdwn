import { requireSameOrigin } from "~/auth/request.server";
import { getEnv } from "~/context/env";
import { treeAction } from "~/tree/tree.server";

import type { Route } from "./+types/private-tree";

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  try { requireSameOrigin(request); }
  catch { return Response.json({ error: "device_proof_required" }, { status: 403,
    headers: { "Cache-Control": "no-store" } }); }
  return treeAction(request, getEnv(context));
}
