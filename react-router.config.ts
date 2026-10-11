import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render the application shell. Private plaintext is never
  // server-rendered: see docs/serving-and-security.md.
  ssr: true,
  // Keep each route module whole. Split builds move a route's HydrateFallback
  // into a chunk the client manifest never references, so hydration renders the
  // root's default fallback instead, fails to match the server HTML, and React
  // leaves the server-rendered fallback page in the document above the real one.
  splitRouteModules: false,
} satisfies Config;
