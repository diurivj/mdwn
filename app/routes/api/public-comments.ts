import { getEnv } from "~/context/env";
import { readPublicCommentPageForLink } from "~/publications/publications.server";

import type { Route } from "./+types/public-comments";

/** Anonymous, cookie-free page of public Comment audience epochs. */
export async function loader({ params, request, context }: Route.LoaderArgs): Promise<Response> {
  const cursorParam = new URL(request.url).searchParams.get("cursor");
  const cursor = cursorParam === null ? 0 : /^\d+$/.test(cursorParam) ? Number(cursorParam) : NaN;
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return Response.json({ error: "not_found" }, { status: 404,
      headers: { "Cache-Control": "no-store" } });
  }
  return readPublicCommentPageForLink(getEnv(context), params.linkId, cursor);
}
