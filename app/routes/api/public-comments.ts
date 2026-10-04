import { getEnv } from "~/context/env";
import { readPublicCommentPageForLink } from "~/publications/publications.server";

import type { Route } from "./+types/public-comments";

/** Anonymous, cookie-free page of public Comment audience epochs. */
export async function loader({ params, request, context }: Route.LoaderArgs): Promise<Response> {
  return readPublicCommentPageForLink(getEnv(context), params.linkId,
    new URL(request.url).searchParams.get("cursor"));
}
