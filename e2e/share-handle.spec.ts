import { build } from "vite";

import { test as appTest, expect } from "./fixtures";
import { cases } from "../tests/support/share-handle-contract";

declare global {
  interface Window {
    mdwnShareHandleV1: typeof import("../tests/support/share-handle-contract");
  }
}

// Bundle the public helper into the test page, not the production client or a test endpoint.
const test = appTest.extend<{}, { shareHandleScript: string }>({
  shareHandleScript: [async ({}, use) => {
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "error",
      build: {
        write: false,
        minify: false,
        lib: {
          entry: "tests/support/share-handle-contract.ts",
          name: "mdwnShareHandleV1",
          formats: ["iife"],
        },
      },
    });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) continue;
      const script = output.output.find((item) => item.type === "chunk");
      if (script?.type === "chunk") {
        await use(script.code);
        return;
      }
    }
    throw new Error("Missing share handle contract bundle");
  }, { scope: "worker" }],
});

for (const contract of cases) {
  test(contract.name, async ({ page, shareHandleScript }) => {
    await page.route("**/__test__/share-handle.js", (route) => route.fulfill({
      contentType: "text/javascript",
      body: shareHandleScript,
    }));
    await page.goto("/", { waitUntil: "commit" });
    await page.addScriptTag({ url: new URL("/__test__/share-handle.js", page.url()).href });
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await page.evaluate(async (name) => {
      const selected = window.mdwnShareHandleV1.cases.find((item) => item.name === name);
      if (!selected) throw new Error("Missing share handle contract");
      await selected.run();
    }, contract.name);
  });
}
