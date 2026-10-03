import { getEnv } from "~/context/env";
import { readPublicPublication } from "~/publications/publications.server";

import type { Route } from "./+types/public-publications";

/** Anonymous, cookie-free Public data: only the opaque path ID is ever received. */
export async function loader({ params, context }: Route.LoaderArgs): Promise<Response> {
  return readPublicPublication(getEnv(context), params.linkId);
}
