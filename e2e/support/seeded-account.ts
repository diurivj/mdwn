import { fileURLToPath } from "node:url";

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { build } from "vite";
import type { TestHarness } from "wrangler";
import { expect } from "../fixtures";
import { coseP256PublicKey } from "./passkey";

declare global {
  interface Window { seededAccountFixture: typeof import("./seeded-account-entry"); }
}

export type SeededAccount = {
  context: BrowserContext;
  page: Page;
  accountId: string;
  deviceId: string;
  rootDirectoryId: string;
  phrase: string;
  recoveryCodes: string[];
  passkey: Awaited<ReturnType<BrowserContext["credentials"]["create"]>>;
  env: { DB: D1Database };
};

let script: Promise<string> | undefined;
function accountScript(): Promise<string> {
  return script ??= build({
    configFile: false, publicDir: false, logLevel: "error",
    resolve: { alias: { "~": fileURLToPath(new URL("../../app", import.meta.url)) } },
    build: { write: false, minify: false, lib: {
      entry: fileURLToPath(new URL("./seeded-account-entry.ts", import.meta.url)),
      name: "seededAccountFixture", formats: ["iife"],
    } },
  }).then((result) => {
    const output = (Array.isArray(result) ? result : [result]).flatMap((item) => "output" in item ? item.output : []);
    const chunk = output.find((item) => item.type === "chunk");
    if (chunk?.type !== "chunk") throw new Error("Missing seeded Account fixture bundle");
    return chunk.code;
  });
}

/** Signup's persisted Account shape, except its Session. Caller owns context.close(). */
export async function seedAccount(browser: Browser, server: TestHarness, baseURL: string): Promise<SeededAccount> {
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  try {
    // Linux WebKit needs a constructor for SimpleWebAuthn's feature detection.
    await context.addInitScript(() => {
      if (typeof globalThis.PublicKeyCredential !== "function") {
        Object.defineProperty(globalThis, "PublicKeyCredential", {
          configurable: true, value: class PublicKeyCredential {},
        });
      }
    });
    const page = await context.newPage();
    const source = await accountScript();
    // Only intercept the script, never the document: later page.goto calls must
    // load the real app. Nothing here is an init script that could reseed on navigation.
    await page.route("**/__test__/seeded-account.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: source }));
    await page.goto(new URL("/sign-in", baseURL).href);
    await page.addScriptTag({ url: new URL("/__test__/seeded-account.js", baseURL).href });
    const material = await page.evaluate(() => window.seededAccountFixture.prepareAccount());
    const { accountId, deviceId, rootDirectoryId, phrase, recoveryCodes } = material;
    const passkey = await context.credentials.create(new URL(baseURL).hostname, {
      userHandle: Buffer.from(accountId, "utf8").toString("base64url"),
    });
    await context.credentials.install();
    const worker = server.getWorker<{ DB: D1Database }>();
    await worker.applyD1Migrations("DB");
    const env = await worker.getEnv(), db = env.DB, now = Date.now();
    const bytes = (value: number[]) => Uint8Array.from(value);
    // Matches signup.server.ts's commit rows. The identity trigger creates the
    // hidden root vault_node and Directory; no Session or abuse/challenge rows.
    await db.batch([
      db.prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind(accountId, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"), now, now),
      db.prepare("INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)")
        .bind(accountId, bytes(material.profile), now, now),
      db.prepare("INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)")
        .bind(accountId, rootDirectoryId),
      db.prepare("INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)")
        .bind(passkey.id, accountId, coseP256PublicKey(passkey.publicKey), now, now),
      db.prepare("INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)")
        .bind(deviceId, accountId, bytes(material.transportPublicKey), bytes(material.assertionPublicKey), now),
      db.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)")
        .bind(accountId, rootDirectoryId, bytes(material.rootRecoveryEnvelope)),
      db.prepare("INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)")
        .bind(accountId, deviceId, deviceId, bytes(material.enrollmentEnvelope)),
      db.prepare("INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, ?, ?, ?)")
        .bind(accountId, bytes(material.recoverySalt), bytes(material.capsule), bytes(material.recoveryVerificationPublicKey)),
      ...material.recoveryCodeHashes.map((hash, ordinal) =>
        db.prepare("INSERT INTO authentication_recovery_codes (account_id, ordinal, code_hash) VALUES (?, ?, ?)")
          .bind(accountId, ordinal, Uint8Array.from(Buffer.from(hash, "base64url")))),
    ]);
    return { context, page, accountId, deviceId, rootDirectoryId, phrase, recoveryCodes, passkey, env };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Real WebAuthn sign-in only; deliberately does not visit a provisioning page. */
export async function signInAccount({ page }: Pick<SeededAccount, "page">): Promise<void> {
  await page.goto(new URL("/sign-in", page.url()).href);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByText("Signed in.", { exact: false })).toBeVisible();
}
