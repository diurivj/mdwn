import { build } from "vite";
import { test as appTest, expect } from "./fixtures";
import { cases } from "../tests/support/file-receiving-contract";

declare global {
  interface Window {
    mdwnFileReceiving: typeof import("../tests/support/file-receiving-contract");
  }
}

// A Playwright-only bundle; no production crypto test endpoint or private keys in SSR.
const test = appTest.extend<{}, { contractScript: string }>({
  contractScript: [async ({}, use) => {
    const result = await build({
      configFile: false, publicDir: false, logLevel: "error",
      build: { write: false, minify: false,
        lib: { entry: "tests/support/file-receiving-contract.ts", name: "mdwnFileReceiving", formats: ["iife"] } },
    });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) continue;
      const script = output.output.find((item) => item.type === "chunk");
      if (script?.type === "chunk") {
        await use(script.code);
        return;
      }
    }
    throw new Error("Missing File receiving contract bundle");
  }, { scope: "worker" }],
});

for (const contract of cases) {
  test(contract.name, async ({ page, contractScript }) => {
    await page.route("**/__test__/file-receiving.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: contractScript }));
    await page.goto("/", { waitUntil: "commit" });
    await page.addScriptTag({ url: new URL("/__test__/file-receiving.js", page.url()).href });
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await page.evaluate(async (name) => {
      const item = window.mdwnFileReceiving.cases.find((c) => c.name === name);
      if (!item) throw new Error("Missing shared File receiving contract");
      await item.run();
    }, contract.name);
  });
}
