import { requireSameOrigin } from "~/auth/request.server";
import { commentsAction } from "~/comments/comments.server";
import { getEnv } from "~/context/env";

import type { Route } from "./+types/private-comments";

export async function action({ request, context }: Route.ActionArgs): Promise<Response> {
  try { requireSameOrigin(request); }
  catch { return Response.json({ error: "device_proof_required" }, { status: 403,
    headers: { "Cache-Control": "no-store" } }); }
  return commentsAction(request, getEnv(context));
}
