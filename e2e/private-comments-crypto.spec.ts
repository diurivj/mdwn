import { build } from "vite";
import { test as appTest, expect } from "./fixtures";
import { cases } from "../tests/support/private-comments-contract";

declare global {
  interface Window {
    mdwnPrivateComments: typeof import("../tests/support/private-comments-contract");
  }
}

// Test-only browser bundle: executes real WebCrypto in Chromium, Firefox and WebKit;
// no production route, SSR plaintext, or mock transport implementation.
const test = appTest.extend<{}, { contractScript: string }>({
  contractScript: [async ({}, use) => {
    const result = await build({
      configFile: false, publicDir: false, logLevel: "error",
      build: { write: false, minify: false,
        lib: { entry: "tests/support/private-comments-contract.ts", name: "mdwnPrivateComments", formats: ["iife"] } },
    });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) continue;
      const script = output.output.find((item) => item.type === "chunk");
      if (script?.type === "chunk") {
        await use(script.code);
        return;
      }
    }
    throw new Error("Missing Private Comment contract bundle");
  }, { scope: "worker" }],
});

for (const contract of cases) {
  test(contract.name, async ({ page, contractScript }) => {
    await page.route("**/__test__/private-comments-crypto.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: contractScript }));
    await page.goto("/", { waitUntil: "commit" });
    await page.addScriptTag({ url: new URL("/__test__/private-comments-crypto.js", page.url()).href });
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await page.evaluate(async (name) => {
      const item = window.mdwnPrivateComments.cases.find((c) => c.name === name);
      if (!item) throw new Error("Missing shared Private Comment contract");
      await item.run();
    }, contract.name);
  });
}
