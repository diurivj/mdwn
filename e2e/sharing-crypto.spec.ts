import { build } from "vite";
import { test as appTest, expect } from "./fixtures";
import { cases } from "../tests/support/sharing-crypto-contract";

declare global {
  interface Window {
    mdwnSharingCrypto: typeof import("../tests/support/sharing-crypto-contract");
  }
}

// Test-only browser bundle, injected into the built Worker's origin (no production endpoint).
const test = appTest.extend<{}, { contractScript: string }>({
  contractScript: [async ({}, use) => {
    const result = await build({
      configFile: false, publicDir: false, logLevel: "error",
      build: { write: false, minify: false,
        lib: { entry: "tests/support/sharing-crypto-contract.ts", name: "mdwnSharingCrypto", formats: ["iife"] } },
    });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) continue;
      const script = output.output.find((item) => item.type === "chunk");
      if (script?.type === "chunk") { await use(script.code); return; }
    }
    throw new Error("Missing sharing crypto contract bundle");
  }, { scope: "worker" }],
});

for (const contract of cases) {
  test(contract.name, async ({ page, contractScript }) => {
    await page.route("**/__test__/sharing-crypto.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: contractScript }));
    await page.goto("/", { waitUntil: "commit" });
    await page.addScriptTag({ url: new URL("/__test__/sharing-crypto.js", page.url()).href });
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await page.evaluate(async (name) => {
      const item = window.mdwnSharingCrypto.cases.find((c) => c.name === name);
      if (!item) throw new Error("Missing sharing crypto contract");
      await item.run();
    }, contract.name);
  });
}
