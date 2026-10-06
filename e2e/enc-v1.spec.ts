import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { build } from "vite";
import { test as appTest, expect } from "./fixtures";
import { cases } from "../tests/support/enc-v1-contract";

declare global {
  interface Window {
    mdwnEncV1: typeof import("../tests/support/enc-v1-contract");
  }
}

// Bundle the actual library for the browser without adding a production test route
// or putting test private keys in build/client. Only this Playwright route serves it.
const test = appTest.extend<{}, { envelopeScript: string }>({
  envelopeScript: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixture function's first parameter to be an object destructuring pattern.
    async ({}, use) => {
      const result = await build({
        configFile: false,
        publicDir: false,
        logLevel: "error",
        resolve: { alias: { "~": new URL("../app", import.meta.url).pathname } },
        build: {
          write: false,
          minify: false,
          lib: { entry: "tests/support/enc-v1-contract.ts", name: "mdwnEncV1", formats: ["iife"] },
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
      throw new Error("Missing browser contract bundle");
    },
    { scope: "worker" },
  ],
});

async function installContract(page: Page, script: string, url = "/") {
  await page.route("**/__test__/enc-v1.js", (route) => route.fulfill({ contentType: "text/javascript", body: script }));
  await page.goto(url, { waitUntil: "commit" });
  await page.addScriptTag({ url: new URL("/__test__/enc-v1.js", page.url()).href });
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
}

for (const contract of cases) {
  test(contract.name, async ({ page, envelopeScript }) => {
    await installContract(page, envelopeScript);
    await page.evaluate(async (name) => {
      const contract = window.mdwnEncV1.cases.find((item) => item.name === name);
      if (!contract) throw new Error("Missing shared contract");
      await contract.run();
    }, contract.name);
  });
}

test("isolates nonce key domains across simultaneous tabs and independent devices", async ({
  playwright,
  browserName,
  baseURL,
  envelopeScript,
}) => {
  const type = playwright[browserName];
  const a = await type.launch();
  const b = await type.launch();
  try {
    const contextA = await a.newContext({ ignoreHTTPSErrors: true });
    const contextB = await b.newContext({ ignoreHTTPSErrors: true });
    const pages = await Promise.all([contextA.newPage(), contextA.newPage(), contextB.newPage()]);
    await Promise.all(pages.map((page) => installContract(page, envelopeScript, baseURL!)));
    const allocations = await Promise.all(
      pages.map((page) =>
        page.evaluate(async () => {
          const { createSymmetricWriter, baseKey, context, inspectEnvelope, hex } = window.mdwnEncV1;
          const writer = await createSymmetricWriter(baseKey);
          return Promise.all(
            Array.from({ length: 4 }, async () => {
              const envelope = await writer.seal(baseKey, context);
              const header = inspectEnvelope(envelope);
              return { salt: hex(header.salt!), nonce: hex(header.nonce!), bytes: Array.from(envelope) };
            }),
          );
        }),
      ),
    );
    expect(new Set(allocations.map((batch) => batch[0].salt)).size).toBe(3);
    for (const batch of allocations) {
      expect(new Set(batch.map((item) => item.salt)).size).toBe(1);
      expect(batch.map((item) => item.nonce)).toEqual([
        "000000000000000000000000",
        "000000000000000000000001",
        "000000000000000000000002",
        "000000000000000000000003",
      ]);
    }
    // Another device can open the envelope despite not sharing any allocator state.
    expect(
      await pages[2].evaluate(async (envelope) => {
        const { openSymmetric, baseKey, context, hex } = window.mdwnEncV1;
        return hex(await openSymmetric(new Uint8Array(envelope), baseKey, { context }));
      }, allocations[0][0].bytes),
    ).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test("does not resume an abandoned nonce sequence after a full browser restart", async ({
  playwright,
  browserName,
  baseURL,
  envelopeScript,
}) => {
  const profile = await mkdtemp(join(tmpdir(), "mdwn-enc-v1-profile-"));
  const type = playwright[browserName];
  try {
    const first = await type.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    let prior: { bytes: number[]; salt: string };
    try {
      const page = await first.newPage();
      await installContract(page, envelopeScript, baseURL!);
      prior = await page.evaluate(async () => {
        const { createSymmetricWriter, baseKey, context, inspectEnvelope, hex } = window.mdwnEncV1;
        const writer = await createSymmetricWriter(baseKey);
        const envelope = await writer.seal(baseKey, context);
        // Abandon a second result. Its encryption may or may not finish before shutdown.
        void writer.seal(baseKey, context).catch(() => undefined);
        return { bytes: Array.from(envelope), salt: hex(inspectEnvelope(envelope).salt!) };
      });
    } finally {
      await first.close();
    }
    const restarted = await type.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    try {
      const page = await restarted.newPage();
      await installContract(page, envelopeScript, baseURL!);
      const after = await page.evaluate(async (previous) => {
        const { createSymmetricWriter, baseKey, context, inspectEnvelope, openSymmetric, hex } = window.mdwnEncV1;
        const writer = await createSymmetricWriter(baseKey);
        const envelope = await writer.seal(baseKey, context);
        const header = inspectEnvelope(envelope);
        return {
          salt: hex(header.salt!),
          nonce: hex(header.nonce!),
          opened: hex(await openSymmetric(new Uint8Array(previous), baseKey, { context })),
        };
      }, prior.bytes);
      expect(after.salt).not.toBe(prior.salt);
      expect(after.nonce).toBe("000000000000000000000000");
      expect(after.opened).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
