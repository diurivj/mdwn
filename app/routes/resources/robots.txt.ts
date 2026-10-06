import { DYNAMIC_CACHE_CONTROL } from "~/shared/security/headers";
import type { Route } from "./+types/robots.txt";

/** Block indexing of all pages; anonymous public pages are non-indexed by default. */
export async function loader({}: Route.LoaderArgs) {
  return new Response("User-agent: *\nDisallow: /\n", {
    headers: { "Content-Type": "text/plain", "Cache-Control": DYNAMIC_CACHE_CONTROL },
  });
}