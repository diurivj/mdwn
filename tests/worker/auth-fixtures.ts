import { env, SELF } from "cloudflare:test";
import { createCookie } from "react-router";
import { expect } from "vitest";

import {
  createNormalSession,
  getActiveSession,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_NAME,
} from "../../app/auth/session.server";

export type SeededAccount = {
  accountId: string;
  credentialIds: string[];
};

export type SeededSession = {
  cookie: string;
  id: string;
};

export async function seedAccount(passkeyCount = 2): Promise<SeededAccount> {
  const accountId = crypto.randomUUID();
  const credentialIds = Array.from({ length: passkeyCount }, () => crypto.randomUUID());
  const now = Date.now();
  await env.DB.batch([
    env.DB
      .prepare("INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(accountId, crypto.randomUUID(), now, now),
    ...credentialIds.map((credentialId) => env.DB
      .prepare(
        `INSERT INTO passkeys (credential_id, account_id, public_key, counter,
          transports, device_type, backed_up, created_at, updated_at)
         VALUES (?, ?, ?, 0, '[]', 'singleDevice', 0, ?, ?)`,
      )
      .bind(credentialId, accountId, Uint8Array.of(1).buffer, now, now)),
  ]);
  return { accountId, credentialIds };
}

export async function signedCookie(sessionId: string): Promise<string> {
  const serialized = await createCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
    secrets: [env.SESSION_COOKIE_SECRET],
  }).serialize(sessionId);
  return serialized.split(";", 1)[0]!;
}

export async function seedNormalSession(
  account: SeededAccount,
  credentialId = account.credentialIds[0]!,
): Promise<SeededSession> {
  const setCookie = await createNormalSession(env, account.accountId, credentialId);
  const cookie = setCookie.split(";", 1)[0]!;
  const session = await getActiveSession(
    new Request("https://mdwn.test/account/security", { headers: { cookie } }),
    env,
  );
  if (!session || session.accountId !== account.accountId) {
    throw new Error("expected a seeded normal Session");
  }
  return { cookie, id: session.id };
}

export async function recoveryCookie(accountId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO sessions (
        id, account_id, purpose, authenticated_passkey_id, created_at,
        idle_expires_at, absolute_expires_at, fresh_asserted_at, refreshed_at, revoked_at
      ) VALUES (?, ?, 'recovery', NULL, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .bind(id, accountId, now, now + SESSION_ABSOLUTE_MS, now + SESSION_ABSOLUTE_MS)
    .run();
  return signedCookie(id);
}

export function mutation(
  path: string,
  cookie: string,
  body: object = {},
  origin = "https://mdwn.test",
): Promise<Response> {
  return SELF.fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify(body),
  });
}

export async function sessionState(cookie: string): Promise<{ authenticated: boolean }> {
  const response = await SELF.fetch("https://mdwn.test/api/auth/session", {
    headers: { cookie },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ authenticated: boolean }>;
}
