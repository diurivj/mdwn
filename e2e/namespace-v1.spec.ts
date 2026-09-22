import { build } from "vite";
import { test as appTest, expect } from "./fixtures";
import { cases } from "../tests/support/namespace-v1-contract";

declare global {
  interface Window {
    mdwnNamespaceV1: typeof import("../tests/support/namespace-v1-contract");
  }
}

const test = appTest.extend<{}, { namespaceScript: string }>({
  namespaceScript: [async ({}, use) => {
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: "error",
      build: {
        write: false,
        minify: false,
        lib: {
          entry: "tests/support/namespace-v1-contract.ts",
          name: "mdwnNamespaceV1",
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
    throw new Error("Missing namespace contract bundle");
  }, { scope: "worker" }],
});

async function installContract(page: import("@playwright/test").Page, script: string): Promise<void> {
  await page.route("**/__test__/namespace-v1.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: script,
  }));
  await page.goto("/", { waitUntil: "commit" });
  await page.addScriptTag({ url: new URL("/__test__/namespace-v1.js", page.url()).href });
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
}

for (const contract of cases) {
  test(contract.name, async ({ page, namespaceScript }) => {
    await installContract(page, namespaceScript);
    await page.evaluate(async (name) => {
      const contract = window.mdwnNamespaceV1.cases.find((item) => item.name === name);
      if (!contract) throw new Error("Missing namespace contract");
      await contract.run();
    }, contract.name);
  });
}
