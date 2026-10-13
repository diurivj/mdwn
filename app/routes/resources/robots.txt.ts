import { DYNAMIC_CACHE_CONTROL } from "~/shared/security/headers";

/**
 * Crawl nothing but the landing page and its preview banner, so link-preview
 * crawlers that honor robots.txt can read the page's preview tags and image.
 * Indexing stays off everywhere: every response, the landing page included,
 * carries `X-Robots-Tag: noindex, nofollow, noarchive`.
 */
export async function loader() {
  return new Response("User-agent: *\nAllow: /$\nAllow: /og-image.jpg\nDisallow: /\n", {
    headers: { "Content-Type": "text/plain", "Cache-Control": DYNAMIC_CACHE_CONTROL },
  });
}
