import type { Browser } from "@playwright/test";
import QRCode from "qrcode";

import { test, expect } from "./fixtures";
import { seedAccount, signInAccount } from "./support/seeded-account";
import { primeSyncedPasskey } from "./support/passkey";

test.setTimeout(240_000);

async function withPasskey(
  browser: Browser,
  origin: string,
  passkey?: Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["credentials"]["get"]>>[number],
) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addInitScript(() => {
    if (typeof globalThis.PublicKeyCredential !== "function") {
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: class PublicKeyCredential {},
      });
    }
  });
  if (passkey) await context.credentials.create(new URL(origin).hostname, passkey);
  await context.credentials.install();
  const page = await context.newPage();
  await page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
  if (passkey) await primeSyncedPasskey(page, passkey.id);
  return { context, page };
}

test("a synced Passkey needs QR approval before the second browser can open Files", async ({
  browser,
  server,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const original = await seedAccount(browser, server, origin);
  const browserErrors: string[] = [];
  original.page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  let candidate: Awaited<ReturnType<typeof withPasskey>> | undefined;
  try {
    await signInAccount(original);
    const passkey = (await original.context.credentials.get())[0]!;
    candidate = await withPasskey(browser, origin, passkey);
    await candidate.page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
    await candidate.page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(candidate.page.getByText("Signed in.", { exact: false })).toBeVisible();
    await candidate.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(candidate.page.getByRole("heading", { name: "Restore private access" })).toBeVisible();
    await candidate.page.getByRole("link", { name: "Enroll this device" }).click();
    await candidate.page.getByLabel("Device label (optional)").fill("Second device");
    await candidate.page.getByRole("button", { name: "Create pairing QR code" }).click();
    await expect(candidate.page.getByRole("heading", { name: "Scan this QR code" })).toBeVisible();
    await expect
      .poll(() =>
        candidate!.page
          .locator("canvas[aria-label='Device pairing QR code']")
          .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
      )
      .toBe(512);
    const pairingLink = await candidate.page.getByRole("textbox", { name: "Pairing link" }).inputValue();
    expect(pairingLink).toContain("#");
    const rawSecret = (
      JSON.parse(atob(pairingLink.split("#")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as {
        pairingSecret: string;
      }
    ).pairingSecret;
    const sent: string[] = [];
    candidate.page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/device-enrollment/")) {
        sent.push(`${request.url()} ${request.postData() ?? ""}`);
      }
    });
    await original.page.goto(`${origin}/enroll-device/approve`, { waitUntil: "commit" });
    const substitutedKeyLink = await candidate.page.evaluate(async (value) => {
      const [base, fragment] = value.split("#");
      const decode = (input: string) => atob(input.replaceAll("-", "+").replaceAll("_", "/"));
      const encode = (input: Uint8Array) =>
        btoa(String.fromCharCode(...input))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
      const payload = JSON.parse(decode(fragment!)) as {
        transcript: {
          accountId: string;
          registryEpoch: number;
          deviceId: string;
          transportPublicKey: string;
          assertionPublicKey: string;
          pairingSecretHash: string;
        };
        transcriptDigest: string;
      };
      const replacement = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      payload.transcript.transportPublicKey = encode(
        new Uint8Array(await crypto.subtle.exportKey("raw", replacement.publicKey)),
      );
      const transcript = payload.transcript;
      const canonical = JSON.stringify([
        "mdwn/device-enrollment-candidate/v1",
        transcript.accountId,
        transcript.registryEpoch,
        transcript.deviceId,
        transcript.transportPublicKey,
        transcript.assertionPublicKey,
        transcript.pairingSecretHash,
      ]);
      payload.transcriptDigest = encode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))),
      );
      return `${base}#${encode(new TextEncoder().encode(JSON.stringify(payload)))}`;
    }, pairingLink);
    await original.page.getByRole("textbox", { name: "Pairing link" }).fill(substitutedKeyLink);
    await original.page.getByRole("button", { name: "Approve device" }).click();
    await expect(original.page.getByRole("alert")).toBeVisible();
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE state = 'active'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    await candidate.page.getByRole("button", { name: "I've scanned it" }).click();
    await expect(candidate.page.getByRole("heading", { name: "Waiting for approval" })).toBeVisible();
    await candidate.page.goto(`${origin}/`, { waitUntil: "commit" });
    await original.page.getByRole("textbox", { name: "Pairing link" }).fill(pairingLink);
    await original.page.getByRole("button", { name: "Approve device" }).click();
    // The candidate's sign-in and fresh assertion advanced its virtual copy
    // twice. The original virtual copy catches up before it can approve.
    await expect(original.page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    const secondAssertion = original.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/passkeys/fresh/verify",
    );
    await original.page.getByRole("button", { name: "Approve device" }).click();
    expect((await secondAssertion).status()).toBe(401);
    const thirdAssertion = original.page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/passkeys/fresh/verify",
    );
    await original.page.getByRole("button", { name: "Approve device" }).click();
    expect((await thirdAssertion).status()).toBe(200);
    await expect(original.page.getByRole("status").or(original.page.getByRole("alert"))).toBeVisible({
      timeout: 30_000,
    });
    expect(await original.page.getByRole("alert").count(), browserErrors.join("\n")).toBe(0);
    await expect(original.page.getByRole("status")).toContainText("Approval sent");
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE state = 'active'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    await candidate.page.route("**/api/private/recovery-provision/next", (route) => route.abort());
    await candidate.page.goto(`${origin}/enroll-device`, { waitUntil: "commit" });
    await expect(candidate.page.getByRole("heading", { name: "Setting up your Files securely…" })).toBeVisible({
      timeout: 120_000,
    });
    expect(
      await env.DB.prepare("SELECT state FROM crypto_jobs WHERE kind = 'enrollment_owned'").first<{ state: string }>(),
    ).toEqual({ state: "pending" });
    await candidate.page.unroute("**/api/private/recovery-provision/next");
    await candidate.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(candidate.page.getByRole("heading", { name: "Private access ready" })).toBeVisible();
    expect(sent.every((request) => !request.includes(rawSecret) && !request.includes("Second device"))).toBe(true);
    const devices = await env.DB.prepare("SELECT state FROM encryption_devices ORDER BY created_at").all<{
      state: string;
    }>();
    expect(devices.results).toEqual([{ state: "active" }, { state: "active" }]);
    const enrolled = await env.DB.prepare(
      "SELECT label_ciphertext FROM encryption_devices WHERE approval_provenance != 'signup'",
    ).first<{ label_ciphertext: ArrayBuffer | number[] }>();
    const ciphertext = new Uint8Array(enrolled!.label_ciphertext);
    expect(ciphertext.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(ciphertext)).not.toContain("Second device");
    await expect
      .poll(
        async () =>
          (
            await env.DB.prepare("SELECT state FROM crypto_jobs WHERE kind = 'enrollment_owned'").first<{
              state: string;
            }>()
          )?.state,
        { timeout: 30_000 },
      )
      .toBe("complete");
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM key_envelopes WHERE purpose = 'owned-device'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await original.page.evaluate(
          async () => (await fetch("/api/auth/session")).json() as Promise<{ authenticated: boolean }>,
        )
      ).authenticated,
    ).toBe(true);
    await original.page.getByRole("textbox", { name: "Pairing link" }).fill(pairingLink);
    await original.page.getByRole("button", { name: "Approve device" }).click();
    await expect(original.page.getByRole("alert")).toBeVisible();
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE state = 'active'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(2);
    await original.page.goto(`${origin}/account/devices`, { waitUntil: "commit" });
    await expect(original.page.getByRole("heading", { name: "Encryption devices" })).toBeVisible();
    await expect(original.page.getByText("Second device", { exact: true })).toBeVisible();
    await expect(original.page.getByText("Unlabelled device", { exact: true })).toBeVisible();
    const document = await (await original.page.request.get(`${origin}/account/devices`)).text();
    expect(document).not.toContain("Second device");
    await expect(original.page.getByText("cannot erase plaintext", { exact: false })).toBeVisible();
    await original.page.getByRole("button", { name: "Remove device" }).click();
    await expect(original.page.getByRole("heading", { name: "Remove Second device?" })).toBeVisible();
    await expect(original.page.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    await original.page.getByLabel("Type Second device to confirm").fill("Wrong device");
    await expect(original.page.getByRole("button", { name: "Confirm removal" })).toBeDisabled();
    await original.page.getByLabel("Type Second device to confirm").fill("Second device");
    await original.page.getByRole("button", { name: "Confirm removal" }).click();
    await expect(original.page.getByRole("status")).toContainText("Device removed", { timeout: 30_000 });
    await expect(original.page.getByText("Second device", { exact: true })).toBeVisible();
    expect(
      (
        await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE state = 'active'").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    await candidate.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(candidate.page.getByRole("heading", { name: "Sign in to access your Files" })).toBeVisible();
    await original.page.goto(`${origin}/account/device-access`, { waitUntil: "commit" });
    await expect(original.page.getByRole("heading", { name: "Private access ready" })).toBeVisible();
  } finally {
    await candidate?.context.close();
    await original.context.close();
  }
});

test("lost candidate keys, expiry, and stale registry state restart without activation", async ({
  browser,
  server,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const original = await seedAccount(browser, server, origin);
  let candidate: Awaited<ReturnType<typeof withPasskey>> | undefined;
  try {
    await signInAccount(original);
    candidate = await withPasskey(browser, origin, (await original.context.credentials.get())[0]!);
    await candidate.page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
    await candidate.page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(candidate.page.getByText("Signed in.", { exact: false })).toBeVisible();
    await candidate.page.goto(`${origin}/enroll-device`, { waitUntil: "commit" });

    const start = async () => {
      await candidate!.page.getByRole("button", { name: "Create pairing QR code" }).click();
      await expect(candidate!.page.getByRole("heading", { name: "Scan this QR code" })).toBeVisible();
      const link = await candidate!.page.getByRole("textbox", { name: "Pairing link" }).inputValue();
      const encoded = link.split("#")[1]!;
      return (
        JSON.parse(atob(encoded.replaceAll("-", "+").replaceAll("_", "/"))) as {
          enrollmentId: string;
        }
      ).enrollmentId;
    };
    const expectRestart = async () => {
      await expect(candidate!.page.getByRole("heading", { name: "Restart device enrollment" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(candidate!.page.getByRole("alert")).toContainText("Start again on this browser");
      expect(
        (
          await env.DB.prepare("SELECT count(*) AS n FROM encryption_devices WHERE state = 'active'").first<{
            n: number;
          }>()
        )?.n,
      ).toBe(1);
    };
    const restart = async () => {
      await candidate!.page.getByRole("button", { name: "Start again" }).click();
      await expect(candidate!.page.getByRole("heading", { name: "Enroll this device" })).toBeVisible();
    };

    await start();
    await candidate.page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("mdwn-device-store");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("pending_enrollment", "readwrite");
        transaction.objectStore("pending_enrollment").clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    });
    await expectRestart();
    await restart();

    const expiredId = await start();
    const now = Date.now();
    await env.DB.prepare("UPDATE device_enrollments SET created_at = ?, expires_at = ? WHERE id = ?")
      .bind(now - 9 * 60_000, now - 1, expiredId)
      .run();
    await expectRestart();
    await restart();

    await start();
    await env.DB.prepare("UPDATE account_encryption_identities SET registry_epoch = registry_epoch + 1").run();
    await expectRestart();
  } finally {
    await candidate?.context.close();
    await original.context.close();
  }
});

test("approval tampering, stale freshness, and a removed approver never activate the candidate", async ({
  browser,
  server,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const worker = server.getWorker<{ DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const original = await seedAccount(browser, server, origin);
  let candidate: Awaited<ReturnType<typeof withPasskey>> | undefined;
  try {
    await signInAccount(original);
    candidate = await withPasskey(browser, origin, (await original.context.credentials.get())[0]!);
    await candidate.page.goto(`${origin}/sign-in`, { waitUntil: "commit" });
    await candidate.page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(candidate.page.getByText("Signed in.", { exact: false })).toBeVisible();
    await candidate.page.goto(`${origin}/enroll-device`, { waitUntil: "commit" });
    await candidate.page.getByRole("button", { name: "Create pairing QR code" }).click();
    await expect(candidate.page.getByRole("heading", { name: "Scan this QR code" })).toBeVisible();
    const pairingLink = await candidate.page.getByRole("textbox", { name: "Pairing link" }).inputValue();
    const enrollmentId = (
      JSON.parse(atob(pairingLink.split("#")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as { enrollmentId: string }
    ).enrollmentId;
    await candidate.page.goto(`${origin}/`, { waitUntil: "commit" });
    await original.page.goto(`${origin}/enroll-device/approve`, { waitUntil: "commit" });
    await original.page.getByRole("textbox", { name: "Pairing link" }).fill(pairingLink);
    for (let attempt = 0; attempt < 3; attempt++) {
      await original.page.getByRole("button", { name: "Approve device" }).click();
      await expect(original.page.getByRole(attempt === 2 ? "status" : "alert")).toBeVisible({ timeout: 30_000 });
    }
    const row = await env.DB.prepare(`SELECT candidate_session_id, candidate_device_id,
      approving_device_id, envelope_digest, approval_signature FROM device_enrollments WHERE id = ?`)
      .bind(enrollmentId)
      .first<{
        candidate_session_id: string;
        candidate_device_id: string;
        approving_device_id: string;
        envelope_digest: ArrayBuffer;
        approval_signature: ArrayBuffer;
      }>();
    expect(row).not.toBeNull();
    const originalDigest = new Uint8Array(row!.envelope_digest);
    const originalSignature = new Uint8Array(row!.approval_signature);
    const expectRejected = async () => {
      await candidate!.page.goto(`${origin}/enroll-device`, { waitUntil: "commit" });
      await expect(candidate!.page.getByRole("heading", { name: "Restart device enrollment" })).toBeVisible({
        timeout: 30_000,
      });
      expect(
        await env.DB.prepare("SELECT id FROM encryption_devices WHERE id = ?").bind(row!.candidate_device_id).first(),
      ).toBeNull();
      await candidate!.page.goto(`${origin}/`, { waitUntil: "commit" });
    };

    await env.DB.prepare("UPDATE device_enrollments SET envelope_digest = ? WHERE id = ?")
      .bind(new Uint8Array(32), enrollmentId)
      .run();
    await expectRejected();
    await env.DB.prepare("UPDATE device_enrollments SET envelope_digest = ? WHERE id = ?")
      .bind(originalDigest, enrollmentId)
      .run();

    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now() - 10 * 60_000, row!.candidate_session_id)
      .run();
    await expectRejected();
    await env.DB.prepare("UPDATE sessions SET fresh_asserted_at = ? WHERE id = ?")
      .bind(Date.now(), row!.candidate_session_id)
      .run();

    await env.DB.prepare("UPDATE device_enrollments SET approval_signature = ? WHERE id = ?")
      .bind(new Uint8Array(64), enrollmentId)
      .run();
    await expectRejected();
    await env.DB.prepare("UPDATE device_enrollments SET approval_signature = ? WHERE id = ?")
      .bind(originalSignature, enrollmentId)
      .run();

    await env.DB.prepare("UPDATE encryption_devices SET state = 'revoked' WHERE id = ?")
      .bind(row!.approving_device_id)
      .run();
    await expectRejected();
  } finally {
    await candidate?.context.close();
    await original.context.close();
  }
});

test("the QR scanner decodes a camera video stream", async ({ page, baseURL }) => {
  const value = "qr-scanner-check";
  const qr = await QRCode.toDataURL(value, { errorCorrectionLevel: "M", width: 512, margin: 4 });
  await page.goto(`${new URL(baseURL!).origin}/enroll-device/approve`, { waitUntil: "commit" });
  await page.evaluate((imageUrl) => {
    const mediaDevices = navigator.mediaDevices;
    // Keep the overridden DOM wrapper reachable; WebKit can otherwise collect
    // it and give the scanner a fresh wrapper with native camera methods.
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    Object.defineProperty(mediaDevices, "enumerateDevices", {
      configurable: true,
      value: async () => [{ kind: "videoinput", deviceId: "qr-test", groupId: "", label: "QR test" }],
    });
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 640;
        const image = new Image();
        image.src = imageUrl;
        await image.decode();
        const context = canvas.getContext("2d")!;
        context.fillStyle = "white";
        context.fillRect(0, 0, 640, 640);
        context.drawImage(image, 64, 64, 512, 512);
        const stream = canvas.captureStream(15);
        const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
        const timer = setInterval(() => {
          context.drawImage(image, 64, 64, 512, 512);
          track.requestFrame?.();
        }, 100);
        const stop = track.stop.bind(track);
        const cleanup = () => track.stop();
        track.stop = () => {
          clearInterval(timer);
          window.removeEventListener("pagehide", cleanup);
          window.removeEventListener("qr-camera-cleanup", cleanup);
          stop();
        };
        window.addEventListener("pagehide", cleanup, { once: true });
        window.addEventListener("qr-camera-cleanup", cleanup, { once: true });
        return stream;
      },
    });
  }, qr);
  try {
    // Expose loss of the camera override when WebKit collects its DOM wrapper.
    await page.requestGC();
    await page.getByRole("button", { name: "Scan QR code" }).click();
    await expect(page.getByRole("textbox", { name: "Pairing link" })).toHaveValue(value, { timeout: 30_000 });
  } finally {
    await page.evaluate(() => window.dispatchEvent(new Event("qr-camera-cleanup")));
  }
});
