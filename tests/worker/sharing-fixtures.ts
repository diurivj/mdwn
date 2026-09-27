import { env } from "cloudflare:test";
import type { AuthorizedDevice } from "../../app/device/proof.server";

/** Real D1 fixture for sharing storage tests; no application test endpoint or mock DB. */
export function fixtureId(): string {
  const uuid = crypto.randomUUID();
  return `${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

export type TestAccount = { accountId: string; rootId: string; device: AuthorizedDevice };

export async function account(): Promise<TestAccount> {
  const accountId = fixtureId(), rootId = fixtureId(), deviceId = fixtureId();
  const credentialId = fixtureId(), sessionId = fixtureId(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)`).bind(accountId, fixtureId(), now, now),
    env.DB.prepare(`INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES (?, ?, 1)`).bind(accountId, rootId),
    env.DB.prepare(`INSERT INTO passkeys (credential_id, account_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at)
      VALUES (?, ?, X'01', 0, '[]', 'singleDevice', 0, ?, ?)`).bind(credentialId, accountId, now, now),
    env.DB.prepare(`INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at)
      VALUES (?, ?, X'01', X'01', 'active', 'signup', 1, ?)`).bind(deviceId, accountId, now),
    env.DB.prepare(`INSERT INTO sessions (id, account_id, purpose, authenticated_passkey_id, device_id, created_at, idle_expires_at, absolute_expires_at)
      VALUES (?, ?, 'normal', ?, ?, ?, ?, ?)`).bind(sessionId, accountId, credentialId, deviceId, now, now + 3600000, now + 3600000),
  ]);
  return { accountId, rootId, device: { accountId, deviceId, sessionId, registryEpoch: 1,
    assertionPublicKey: new Uint8Array([1]), proofId: fixtureId(), expiresAt: now + 3600000 } };
}

export async function node(owner: TestAccount, parentId: string, kind: "file" | "directory"): Promise<string> {
  const id = fixtureId(), now = Date.now();
  const inserts = [env.DB.prepare(`INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(id, kind, owner.accountId, parentId, now, now)];
  if (kind === "directory") inserts.push(env.DB.prepare(`INSERT INTO directories (node_id, owner_id, entries_revision)
    VALUES (?, ?, 1)`).bind(id, owner.accountId));
  else {
    const reprId = fixtureId();
    inserts.push(env.DB.prepare(`INSERT INTO files (node_id, owner_id, current_representation_id, current_revision)
      VALUES (?, ?, ?, 1)`).bind(id, owner.accountId, reprId));
    inserts.push(env.DB.prepare(`INSERT INTO file_representations (id, file_node_id, owner_id, revision, content_key_id, key_epoch, ciphertext, ciphertext_size, created_at)
      VALUES (?, ?, ?, 1, ?, 1, X'01', 1, ?)`).bind(reprId, id, owner.accountId, fixtureId(), now));
  }
  inserts.push(env.DB.prepare(`INSERT INTO directory_entries (child_node_id, owner_id, parent_node_id, name_ciphertext, order_ciphertext, key_envelope, encoding)
    VALUES (?, ?, ?, X'01', X'01', X'01', ?)`).bind(id, owner.accountId, parentId, kind === "directory" ? "directory" : "legacy-file"));
  await env.DB.batch(inserts);
  return id;
}

export async function share(owner: TestAccount, recipient: TestAccount, target: string, kind: "file" | "directory", permission: "read_only" | "read_write", id = fixtureId()) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO shares (id, owner_id, recipient_id, target_node_id, target_kind, permission, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, owner.accountId, recipient.accountId, target, kind, permission, now).run();
  return id;
}

export async function grant(owner: TestAccount, recipient: TestAccount, target: string, kind: "file" | "directory", permission: "read_only" | "read_write", id = fixtureId()) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO grants (id, owner_id, recipient_id, target_node_id, target_kind, permission, generation, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).bind(id, owner.accountId, recipient.accountId, target, kind, permission, now, now).run();
  return id;
}
