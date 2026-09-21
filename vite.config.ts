import { resolve } from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const encV1BrowserVectorPlugin: Plugin = {
  name: "mdwn-enc-v1-browser-vector",
  apply: "build",
  buildStart() {
    this.emitFile({
      type: "chunk",
      id: resolve(process.cwd(), "app/crypto/browser-test-entry.ts"),
      fileName: "assets/enc-v1-browser-test.js",
    });
  },
};

export default defineConfig({
  plugins: [
    encV1BrowserVectorPlugin,
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});