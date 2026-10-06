import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render the application shell. Private plaintext is never
  // server-rendered: see docs/serving-and-security.md.
  ssr: true,
} satisfies Config;
