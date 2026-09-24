import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { completeRecoveryPresentation } from "./signup-recovery";

test.setTimeout(180_000);

async function candidate(browser: Browser, origin: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true, value: class PublicKeyCredential {},
      });
    }
  });
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-up`, { waitUntil: "commit" });
  return { context, page };
}

type Submission = { challengeId: string; transcript: {
  transportPublicKey: string; capsuleDigest: string; registrationChallenge: string;
}; bindingSignature: string; transportProof: string; [key: string]: unknown };

for (const scenario of ["candidate key", "capsule digest", "registration challenge", "binding signature", "transport proof"] as const) {
  test(`rejects altered ${scenario} with no Account`, async ({ browser, server, baseURL }) => {
    const worker = server.getWorker<{DB:D1Database}>();
    await worker.applyD1Migrations("DB");
    const env = await worker.getEnv();
    const { context, page } = await candidate(browser, new URL(baseURL!).origin);
    try {
      const alter = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
      let submitted = false;
      await page.route("**/api/signup/verify", async (route) => {
        const body = route.request().postDataJSON() as Submission;
        if (scenario === "candidate key") body.transcript.transportPublicKey = alter(body.transcript.transportPublicKey);
        if (scenario === "capsule digest") body.transcript.capsuleDigest = alter(body.transcript.capsuleDigest);
        if (scenario === "registration challenge") body.transcript.registrationChallenge = alter(body.transcript.registrationChallenge);
        if (scenario === "binding signature") body.bindingSignature = "A".repeat(86);
        if (scenario === "transport proof") body.transportProof = "A".repeat(43);
        submitted = true;
        await route.continue({ postData: JSON.stringify(body) });
      });
      await page.getByRole("button", {name:"Create account",exact:true}).click();
      await completeRecoveryPresentation(page);
      await expect(page.getByRole("alert")).toContainText("could not create your account", {timeout:120_000});
      expect(submitted).toBe(true);
      expect(await env.DB.prepare("SELECT count(*) AS n FROM accounts").first()).toEqual({n:0});
      expect(await env.DB.prepare("SELECT count(*) AS n FROM sessions").first()).toEqual({n:0});
    } finally { await context.close(); }
  });
}

for (const scenario of ["bad binding proof", "tombstoned device"] as const) {
  test(`sign-in with ${scenario} stays unprovisioned`, async ({ browser, server, baseURL }) => {
    const worker = server.getWorker<{DB:D1Database}>();
    await worker.applyD1Migrations("DB");
    const env = await worker.getEnv();
    const { context, page } = await candidate(browser, new URL(baseURL!).origin);
    try {
      await page.getByRole("button", {name:"Create account",exact:true}).click();
      await completeRecoveryPresentation(page);
      await expect(page.getByText("Your account is ready.", {exact:false})).toBeVisible({timeout:120_000});
      const account = await env.DB.prepare("SELECT id FROM accounts").first<{id:string}>();
      expect(account).not.toBeNull();
      const signedOut = await page.evaluate(async () => fetch("/api/auth/sign-out", {
        method:"POST", headers:{"Content-Type":"application/json"}, body:"{}",
      }).then((result) => result.status));
      expect(signedOut).toBe(200);
      if (scenario === "tombstoned device") {
        await env.DB.prepare("UPDATE encryption_devices SET state='tombstoned' WHERE account_id=?").bind(account!.id).run();
      }
      await page.goto(`${new URL(baseURL!).origin}/sign-in`, {waitUntil:"commit"});
      let presented = false;
      await page.route("**/api/auth/sign-in/verify", async (route) => {
        const body = route.request().postDataJSON() as { deviceProof?: { signature: string }; [key:string]:unknown };
        expect(body.deviceProof).toBeDefined();
        presented = true;
        if (scenario === "bad binding proof") body.deviceProof!.signature = "A".repeat(86);
        await route.continue({postData:JSON.stringify(body)});
      });
      await page.getByRole("button", {name:"Sign in with a passkey"}).click();
      await expect(page.getByText("This browser has no active Encryption device", {exact:false})).toBeVisible();
      expect(presented).toBe(true);
      expect(await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE account_id=? AND device_id IS NULL")
        .bind(account!.id).first()).toEqual({n:1});
      const read = await page.evaluate(async () => (await fetch("/api/private/bootstrap", {method:"POST"})).status);
      expect(read).toBe(403);
    } finally { await context.close(); }
  });
}

test("losing a persisted private key before passkey registration never activates a device", async ({ browser, server, baseURL }) => {
  const worker = server.getWorker<{DB:D1Database}>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const { context, page } = await candidate(browser, new URL(baseURL!).origin);
  try {
    await page.route("**/api/signup/options", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await page.evaluate(async () => {
        const opening = indexedDB.open("mdwn-device-store", 1);
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          opening.onsuccess = () => resolve(opening.result);
          opening.onerror = () => reject(opening.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("devices", "readwrite");
          const request = tx.objectStore("devices").getAll();
          request.onsuccess = () => {
            for (const record of request.result) {
              record.assertionKeyPair.privateKey = undefined;
              tx.objectStore("devices").put(record);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      await route.fulfill({ response });
    });
    await page.getByRole("button", {name:"Create account",exact:true}).click();
    await completeRecoveryPresentation(page);
    await expect(page.getByRole("alert")).toContainText("could not create your account", {timeout:120_000});
    expect(await env.DB.prepare("SELECT count(*) AS n FROM accounts").first()).toEqual({n:0});
  } finally { await context.close(); }
});
