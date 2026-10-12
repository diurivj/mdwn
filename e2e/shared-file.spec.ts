import { createCookie } from "react-router";
import { createVaultKeyHierarchy, sealDeviceEnrollmentEnvelope } from "../app/shared/crypto/vault";
import { test, expect, installWorkspaceScript, objectId } from "./workspace-fixture";
import { TEST_SESSION_COOKIE_SECRET } from "./fixtures";
import { newPublicationIdentifier } from "../app/shared/publications/capability";
import type { GrantKeyContext } from "../app/shared/sharing/grant-keys";
import type { CommentKeyContext } from "../app/shared/sharing/comment-keys";
import { waitForSharedProvisioning } from "./support/navigation";

test.use({ initialSource: "# Shared secret\n\nOnly the target File." });

for (const targetKind of ["file", "directory"] as const)
  for (const permission of ["read_write", "read_only"] as const) {
    test(`a ${permission} ${targetKind} recipient opens its scope, and a new device stays provisioning-only`, async ({
      browser,
      page,
      workspace,
      workspaceScript,
      baseURL,
    }) => {
      const recipientContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const recipient = await recipientContext.newPage();
      const pendingContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const pendingDevice = await pendingContext.newPage();
      const accountId = objectId(),
        rootId = objectId(),
        deviceId = objectId(),
        credentialId = objectId(),
        sessionId = objectId(),
        shareId = objectId();
      const commentIds = [objectId(), objectId()];
      const now = Date.now();
      try {
        await installWorkspaceScript(recipient, workspaceScript, baseURL!);
        const publicKeys = await recipient.evaluate(
          async ({ accountId, deviceId }) => {
            const device = await window.workspaceFixture.createDevice(accountId, deviceId);
            await window.workspaceFixture.updateRegistryEpoch(accountId, 1);
            return {
              transport: Array.from(
                new Uint8Array(await crypto.subtle.exportKey("raw", device.transportKeyPair.publicKey)),
              ),
              assertion: Array.from(
                new Uint8Array(await crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey)),
              ),
            };
          },
          { accountId, deviceId },
        );
        const hierarchy = await createVaultKeyHierarchy({ accountId, rootDirectoryId: rootId });
        const transport = await crypto.subtle.importKey(
          "raw",
          Uint8Array.from(publicKeys.transport),
          { name: "ECDH", namedCurve: "P-256" },
          true,
          [],
        );
        const enrollment = await sealDeviceEnrollmentEnvelope(hierarchy.vaultRootKey, transport, {
          purpose: "device-enrollment",
          vaultId: accountId,
          objectId: deviceId,
          keyId: deviceId,
          keyEpoch: 1,
          revision: 1,
          recipientId: deviceId,
        });
        await workspace.db.batch([
          workspace.db
            .prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(accountId, shareId, now, now),
          workspace.db
            .prepare(
              "INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)",
            )
            .bind(credentialId, accountId, now, now),
          workspace.db
            .prepare(
              "INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)",
            )
            .bind(accountId, rootId),
          workspace.db
            .prepare(
              "INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'signup', 1, ?)",
            )
            .bind(
              deviceId,
              accountId,
              Uint8Array.from(publicKeys.transport),
              Uint8Array.from(publicKeys.assertion),
              now,
            ),
          workspace.db
            .prepare(
              "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'vault-recovery', ?, 'vault-root', ?, 1)",
            )
            .bind(accountId, rootId, hierarchy.rootDirectoryRecoveryEnvelope),
          workspace.db
            .prepare(
              "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)",
            )
            .bind(accountId, deviceId, deviceId, enrollment),
          workspace.db
            .prepare(
              "INSERT INTO recovery_capsules (account_id, generation, recovery_salt, ciphertext, verification_public_key) VALUES (?, 1, zeroblob(32), X'01', X'01')",
            )
            .bind(accountId),
          workspace.db
            .prepare(
              "INSERT INTO account_profiles (account_id, ciphertext, revision, epoch, created_at, updated_at) VALUES (?, X'01', 1, 1, ?, ?)",
            )
            .bind(accountId, now, now),
          workspace.db
            .prepare(
              "INSERT INTO sessions (id, account_id, purpose, authenticated_passkey_id, device_id, created_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, 'normal', ?, ?, ?, ?, ?)",
            )
            .bind(sessionId, accountId, credentialId, deviceId, now, now + 3_600_000, now + 86_400_000),
        ]);
        const cookie = await createCookie("__Host-mdwn_session", {
          path: "/",
          secure: true,
          secrets: [TEST_SESSION_COOKIE_SECRET],
        }).serialize(sessionId);
        await recipientContext.addCookies([
          {
            name: "__Host-mdwn_session",
            value: cookie.split(";", 1)[0]!.slice("__Host-mdwn_session=".length),
            url: new URL(baseURL!).origin,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ]);
        const epochPublicationId = newPublicationIdentifier();
        for (const [index, objectId] of commentIds.entries())
          await workspace.db
            .prepare(`INSERT INTO sharing_comment_capabilities
      (object_id, owner_id, file_id, thread_id, purpose, publication_id, capability_id, capability_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
            .bind(
              objectId,
              workspace.accountId,
              workspace.fileId,
              objectId,
              index === 0 ? "private-comment-thread" : "public-comment-audience-epoch",
              index === 0 ? null : epochPublicationId,
              objectId,
            )
            .run();
        await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
        const grantId = await page.evaluate(
          async ({ fileId, shareId, targetKind, permission }) => {
            const api = window.workspaceFixture,
              access = await api.openRoot();
            const listing = await api.loadDirectory(access, access.rootId, access.rootKey);
            const file = await api.loadFile(access, fileId, access.rootKey);
            await api.convertFileCapability(access, fileId, file, access.rootKey, listing);
            const converted = await api.loadFile(access, fileId, access.rootKey);
            const invitation = await api.privateRequest("/api/private/shares", {
              method: "PUT",
              body: JSON.stringify({
                targetId: targetKind === "file" ? fileId : access.rootId,
                recipient: { shareId },
                permission,
              }),
            });
            if (!invitation.ok) throw new Error("Invitation failed");
            const { shareId: relationshipId } = (await invitation.json()) as { shareId: string };
            const targetsResponse = await api.privateRequest(`/api/private/shares/${relationshipId}/keys`, {
              method: "POST",
            });
            if (!targetsResponse.ok) throw new Error("Delivery targets failed");
            const targets = (await targetsResponse.json()) as GrantKeyContext & {
              devices: { deviceId: string; transportPublicKey: string }[];
            };
            const signer = await api.getDevice(access.actorAccountId);
            if (!signer || !converted.capabilityKey) throw new Error("Missing approved keys");
            const envelopes = await Promise.all(
              targets.devices.map(async (device: { deviceId: string; transportPublicKey: string }) => {
                const raw = Uint8Array.from(
                  atob(device.transportPublicKey.replace(/-/g, "+").replace(/_/g, "/")),
                  (char) => char.charCodeAt(0),
                );
                const publicKey = await crypto.subtle.importKey(
                  "raw",
                  raw,
                  { name: "ECDH", namedCurve: "P-256" },
                  true,
                  [],
                );
                return api.createGrantKeyEnvelope(
                  targetKind === "file" ? converted.capabilityKey! : access.rootKey,
                  publicKey,
                  signer.assertionKeyPair.privateKey,
                  { ...targets, deviceId: device.deviceId, signerDeviceId: signer.deviceId },
                );
              }),
            );
            const prepared = await api.privateRequest(`/api/private/shares/${relationshipId}/keys`, {
              method: "PUT",
              body: JSON.stringify({
                capabilityId: targets.capabilityId,
                capabilityEpoch: targets.capabilityEpoch,
                ownerRegistryEpoch: targets.ownerRegistryEpoch,
                recipientRegistryEpoch: targets.recipientRegistryEpoch,
                envelopes,
              }),
            });
            if (!prepared.ok) throw new Error("Provisioning failed");
            const comments = (await (
              await api.privateRequest(`/api/private/shares/${relationshipId}/comment-keys`, { method: "POST" })
            ).json()) as { capabilities: CommentKeyContext[] };
            for (const context of comments.capabilities) {
              const keyPath = `/api/private/shares/${relationshipId}/comment-keys/${context.objectId}`;
              const commentTargets = (await (
                await api.privateRequest(keyPath, { method: "POST" })
              ).json()) as CommentKeyContext & { devices: { deviceId: string; transportPublicKey: string }[] };
              const packets = await Promise.all(
                commentTargets.devices.map(async (device) => {
                  const raw = Uint8Array.from(
                    atob(device.transportPublicKey.replace(/-/g, "+").replace(/_/g, "/")),
                    (char) => char.charCodeAt(0),
                  );
                  const publicKey = await crypto.subtle.importKey(
                    "raw",
                    raw,
                    { name: "ECDH", namedCurve: "P-256" },
                    true,
                    [],
                  );
                  return api.createCommentKeyEnvelope(
                    new Uint8Array(32).fill(86),
                    publicKey,
                    signer.assertionKeyPair.privateKey,
                    { ...commentTargets, deviceId: device.deviceId, signerDeviceId: signer.deviceId },
                  );
                }),
              );
              const uploaded = await api.privateRequest(keyPath, {
                method: "PUT",
                body: JSON.stringify({
                  capabilityId: context.capabilityId,
                  capabilityEpoch: context.capabilityEpoch,
                  ownerRegistryEpoch: context.ownerRegistryEpoch,
                  recipientRegistryEpoch: context.recipientRegistryEpoch,
                  envelopes: packets,
                }),
              });
              if (!uploaded.ok) throw new Error("Comment provisioning failed");
            }
            return relationshipId as string;
          },
          { fileId: workspace.fileId, shareId, targetKind, permission },
        );
        expect(
          await recipient.evaluate(
            async (id) =>
              (
                await window.workspaceFixture.privateRequest(`/api/private/shares/${id}/accept`, {
                  method: "POST",
                  body: "{}",
                })
              ).status,
            grantId,
          ),
        ).toBe(201);
        const listingBefore = await workspace.db
          .prepare("SELECT entries_revision FROM directories WHERE node_id = ?")
          .bind(workspace.rootId)
          .first();
        const privateReads: string[] = [];
        recipient.on("request", (request) => {
          if (new URL(request.url()).pathname.startsWith("/api/private/tree/directories/"))
            privateReads.push(request.url());
        });
        await recipient.goto(new URL(`/f/${workspace.fileId}`, baseURL!).href);
        await expect(recipient.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
          "# Shared secret\n\nOnly the target File.",
        );
        if (targetKind === "file") {
          await expect(recipient.getByRole("heading", { name: "Shared File", exact: true })).toBeVisible();
          await expect(recipient.getByRole("button", { name: "New folder", exact: true })).toHaveCount(0);
          await expect(recipient.getByText("Draft.md", { exact: true })).toHaveCount(0);
          expect(privateReads).toEqual([]);
        } else {
          await expect(
            recipient
              .getByRole("navigation", { name: "Files", exact: true })
              .getByRole("link", { name: "Draft.md", exact: true }),
          ).toBeVisible();
          expect(privateReads.map((url) => new URL(url).pathname)).toEqual([
            `/api/private/tree/directories/${workspace.rootId}`,
          ]);
        }
        await recipient.addScriptTag({ url: new URL("/__test__/workspace.js", recipient.url()).href });
        expect(
          await recipient.evaluate(async (id) => {
            const api = window.workspaceFixture;
            const { capabilities } = (await (
              await api.privateRequest(`/api/private/grants/${id}/comment-keys`, { method: "POST" })
            ).json()) as { capabilities: CommentKeyContext[] };
            const device = await api.getDevice(capabilities[0]!.recipientId);
            if (!device) throw new Error("Missing recipient");
            for (const expected of capabilities) {
              const response = await api.privateRequest(`/api/private/grants/${id}/comment-keys/${expected.objectId}`, {
                method: "POST",
              });
              if (!response.ok) throw new Error("Comment access unavailable");
              const envelope = (await response.json()) as Parameters<typeof api.openCommentKeyEnvelope>[0];
              const key = await api.openCommentKeyEnvelope({ ...envelope, recipient: device.transportKeyPair });
              if (key.length !== 32 || key.some((byte) => byte !== 86)) throw new Error("Wrong Comment capability");
            }
            return capabilities.map((item) => item.purpose).sort();
          }, grantId),
        ).toEqual(["private-comment-thread", "public-comment-audience-epoch"]);
        if (permission === "read_write") {
          const saveResponse = recipient.waitForResponse(
            (response) =>
              response.request().method() === "PATCH" &&
              new URL(response.url()).pathname === `/api/private/tree/files/${workspace.fileId}`,
          );
          await recipient.getByRole("textbox", { name: "Markdown source", exact: true }).fill("# Saved directly");
          expect((await saveResponse).status()).toBe(200);
          await expect(recipient.getByRole("status", { name: "File save status" })).toHaveText("Saved");
          expect(
            await workspace.db
              .prepare("SELECT entries_revision FROM directories WHERE node_id = ?")
              .bind(workspace.rootId)
              .first(),
          ).toEqual(listingBefore);
          await waitForSharedProvisioning(recipient);
          await recipient.reload();
          await expect(recipient.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
            "# Saved directly",
          );
          expect(await (await recipient.request.get(`/f/${workspace.fileId}`)).text()).not.toContain("Saved directly");
        } else {
          await expect(recipient.getByRole("textbox", { name: "Markdown source", exact: true })).not.toBeEditable();
          await expect(
            recipient.getByRole("status").filter({ hasText: /^Read-only — you can comment$/ }),
          ).toBeVisible();
          await expect(recipient.getByRole("button", { name: "New folder", exact: true })).toHaveCount(0);
        }

        // Simulate a separately enrolled current device at the external registry/auth
        // boundary. Its owned-root envelope contains no Grant key; ticket20 must fulfill it.
        await installWorkspaceScript(pendingDevice, workspaceScript, baseURL!);
        const replacementId = objectId();
        const nextKeys = await pendingDevice.evaluate(
          async ({ accountId, replacementId }) => {
            const device = await window.workspaceFixture.createDevice(accountId, replacementId);
            await window.workspaceFixture.updateRegistryEpoch(accountId, 2);
            return {
              transport: Array.from(
                new Uint8Array(await crypto.subtle.exportKey("raw", device.transportKeyPair.publicKey)),
              ),
              assertion: Array.from(
                new Uint8Array(await crypto.subtle.exportKey("raw", device.assertionKeyPair.publicKey)),
              ),
            };
          },
          { accountId, replacementId },
        );
        const nextEnvelope = await sealDeviceEnrollmentEnvelope(
          hierarchy.vaultRootKey,
          await crypto.subtle.importKey(
            "raw",
            Uint8Array.from(nextKeys.transport),
            { name: "ECDH", namedCurve: "P-256" },
            true,
            [],
          ),
          {
            purpose: "device-enrollment",
            vaultId: accountId,
            objectId: replacementId,
            keyId: replacementId,
            keyEpoch: 1,
            revision: 1,
            recipientId: replacementId,
          },
        );
        await workspace.db.batch([
          workspace.db
            .prepare(
              "INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at) VALUES (?, ?, ?, ?, 'active', 'routine', 2, ?)",
            )
            .bind(
              replacementId,
              accountId,
              Uint8Array.from(nextKeys.transport),
              Uint8Array.from(nextKeys.assertion),
              now,
            ),
          workspace.db
            .prepare(
              "INSERT INTO key_envelopes (account_id, purpose, object_id, recipient_id, ciphertext, key_epoch) VALUES (?, 'device-enrollment', ?, ?, ?, 1)",
            )
            .bind(accountId, replacementId, replacementId, nextEnvelope),
          workspace.db.prepare("UPDATE sessions SET device_id = ? WHERE id = ?").bind(replacementId, sessionId),
        ]);
        await pendingContext.addCookies([
          {
            name: "__Host-mdwn_session",
            value: cookie.split(";", 1)[0]!.slice("__Host-mdwn_session=".length),
            url: new URL(baseURL!).origin,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ]);
        const fragment = await page.evaluate(async (fileId) => {
          const api = window.workspaceFixture,
            access = await api.openRoot();
          const file = await api.loadFile(access, fileId, access.rootKey);
          const key = file.capabilityKey!;
          return btoa(String.fromCharCode(...key))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        }, workspace.fileId);
        const requests: string[] = [];
        pendingDevice.on("request", (request) => requests.push(request.url() + (request.postData() ?? "")));
        await pendingDevice.goto(new URL(`/f/${workspace.fileId}#${fragment}`, baseURL!).href);
        await expect(
          pendingDevice.getByText("Shared content is being securely provisioned", { exact: true }),
        ).toBeVisible();
        await expect(pendingDevice.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveCount(0);
        await expect(pendingDevice.getByText("Draft.md", { exact: true })).toHaveCount(0);
        expect(requests.some((request) => request.includes(fragment))).toBe(false);
        await pendingDevice.addScriptTag({ url: new URL("/__test__/workspace.js", pendingDevice.url()).href });
        for (const objectId of commentIds) {
          expect(
            await pendingDevice.evaluate(
              async ({ grantId, objectId }) => {
                const response = await window.workspaceFixture.privateRequest(
                  `/api/private/grants/${grantId}/comment-keys/${objectId}`,
                  { method: "POST" },
                );
                return { status: response.status, value: await response.json() };
              },
              { grantId, objectId },
            ),
          ).toEqual({ status: 409, value: { error: "secure_access_preparing" } });
        }
        const needs = await workspace.db
          .prepare("SELECT device_id, grant_key_epoch FROM provisioning_needs WHERE grant_id = ?")
          .bind(grantId)
          .all();
        expect(needs.results).toEqual([{ device_id: replacementId, grant_key_epoch: 1 }]);

        const shell = await (await page.request.get("/account/shared-access")).text();
        expect(shell).not.toContain(grantId);
        expect(shell).not.toContain("Draft.md");
        const automaticDelivery = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            new URL(response.url()).pathname === `/api/private/grants/${grantId}/keys`,
        );
        // Background upkeep starts at most once a minute per tab (ticket 57),
        // and the fixture's File page already ran it; a new document starts it.
        await waitForSharedProvisioning(page);
        await page.goto(new URL("/files", baseURL!).href);
        await expect(page).toHaveURL(/\/files$/);
        expect((await automaticDelivery).status()).toBe(200);
        await page
          .getByRole("complementary", { name: "Files tree", exact: true })
          .getByRole("link", { name: "Shared access", exact: true })
          .click();
        await expect(page).toHaveURL(new URL("/account/shared-access", baseURL!).href);
        await page.getByRole("button", { name: "Provision shared content", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Shared access pass complete" })).toBeVisible();
        await pendingDevice.reload();
        await expect(pendingDevice.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveValue(
          permission === "read_write" ? "# Saved directly" : "# Shared secret\n\nOnly the target File.",
        );
        // Root delivery does not silently claim that missing Comment history is complete.
        await pendingDevice.addScriptTag({ url: new URL("/__test__/workspace.js", pendingDevice.url()).href });
        expect(
          await pendingDevice.evaluate(
            async ({ grantId, objectId }) =>
              (
                await window.workspaceFixture.privateRequest(
                  `/api/private/grants/${grantId}/comment-keys/${objectId}`,
                  { method: "POST" },
                )
              ).status,
            { grantId, objectId: commentIds[0]! },
          ),
        ).toBe(409);

        await page.addScriptTag({ url: new URL("/__test__/workspace.js", page.url()).href });
        expect(
          await page.evaluate(
            async (grantId) =>
              (
                await window.workspaceFixture.privateRequest(`/api/private/grants/${grantId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ expectedRevision: 1, expiresAt: Date.now() + 60_000 }),
                })
              ).status,
            grantId,
          ),
        ).toBe(200);
        // Settle the fresh File document before revoking its access, not after denial.
        await waitForSharedProvisioning(pendingDevice);
        // Move only the persisted deadline across the external time boundary, not browser proof clocks.
        await workspace.db.prepare("UPDATE grants SET expires_at = 1 WHERE id = ?").bind(grantId).run();
        await pendingDevice.reload();
        await expect(pendingDevice.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();
        await expect(pendingDevice.getByRole("textbox", { name: "Markdown source", exact: true })).toHaveCount(0);
        await page.reload();
        await page.getByRole("button", { name: "Provision shared content", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Shared access pass complete" })).toBeVisible();
        await page.goto(new URL("/account/key-rotations", baseURL!).href);
        await expect(page.getByRole("button", { name: "Resume update", exact: true })).toBeVisible();
      } finally {
        await Promise.all([recipientContext.close(), pendingContext.close()]);
      }
    });
  }
