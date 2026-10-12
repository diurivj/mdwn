import { privateExchange, privateRequest } from "~/shared/device/private-client";
import { isV7 } from "~/shared/tree/wire";

/**
 * Typed, proof-guarded access to the Share and Grant relationship endpoints
 * (see docs/sharing.md). Lists carry opaque identities, target kind and
 * permission only; Owner rows add the recipient's share identifier. Nothing
 * here opens a key or reveals a name.
 */

export type RelationshipPermission = "read_only" | "read_write";
export type RelationshipTargetKind = "file" | "directory";

type RelationshipCore = {
  ownerId: string;
  recipientId: string;
  targetId: string;
  targetKind: RelationshipTargetKind;
  permission: RelationshipPermission;
};
export type IncomingShare = RelationshipCore & { shareId: string };
export type OutgoingShare = IncomingShare & { recipientShareId: string };
export type ReceivedGrant = RelationshipCore & {
  grantId: string;
  revision: number;
  keyEpoch: number;
  expiresAt: number | null;
};
export type OwnedGrant = ReceivedGrant & { recipientShareId: string };

export type SharesPage = { incoming: IncomingShare[]; outgoing: OutgoingShare[]; nextCursor: string | null };
export type GrantsPage = { received: ReceivedGrant[]; owned: OwnedGrant[]; nextCursor: string | null };
export type Relationships = {
  accountId: string;
  incoming: IncomingShare[];
  outgoing: OutgoingShare[];
  received: ReceivedGrant[];
  owned: OwnedGrant[];
};

/** The server's combined page bound. */
const PAGE_SIZE = 100;
/** At most this many pages (2,000 relationships per list) are read in one pass. */
export const MAX_RELATIONSHIP_PAGES = 20;

/** 409 `sharing_changed`: the relationship changed, or (on acceptance) the
 * Owner's browser has not finished preparing secure access for every device. */
export class SharingChangedError extends Error {
  constructor() {
    super("sharing changed");
    this.name = "SharingChangedError";
  }
}

/** 409 `key_rotation_required`: a secure access update must finish for this item first. */
export class KeyRotationRequiredError extends Error {
  constructor() {
    super("key rotation required");
    this.name = "KeyRotationRequiredError";
  }
}

/** 409 `already_shared`: that Account already has an invitation or access for this item. */
export class AlreadySharedError extends Error {
  constructor() {
    super("already shared");
    this.name = "AlreadySharedError";
  }
}

/** More pages than one bounded pass reads (`MAX_RELATIONSHIP_PAGES`). */
export class SharingPageLimitError extends Error {
  constructor() {
    super("too many sharing pages");
    this.name = "SharingPageLimitError";
  }
}

/** 404: the relationship no longer exists or is not this Account's to change. */
export class SharingNotFoundError extends Error {
  constructor() {
    super("sharing relationship not found");
    this.name = "SharingNotFoundError";
  }
}

function invalid(): never {
  throw new Error("invalid sharing response");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) invalid();
}

const accountIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

const CORE = ["ownerId", "recipientId", "targetId", "targetKind", "permission"] as const;
const GRANT = [...CORE, "grantId", "revision", "keyEpoch", "expiresAt"] as const;

function core(row: Record<string, unknown>, accountId: string, owned: boolean): RelationshipCore {
  if (
    !accountIdentity(row.ownerId) ||
    !accountIdentity(row.recipientId) ||
    row.ownerId === row.recipientId ||
    (owned ? row.ownerId : row.recipientId) !== accountId ||
    !isV7(row.targetId) ||
    (row.targetKind !== "file" && row.targetKind !== "directory") ||
    (row.permission !== "read_only" && row.permission !== "read_write")
  )
    invalid();
  return {
    ownerId: row.ownerId,
    recipientId: row.recipientId,
    targetId: row.targetId,
    targetKind: row.targetKind,
    permission: row.permission,
  };
}

function recipientShareId(row: Record<string, unknown>): string {
  if (!accountIdentity(row.recipientShareId)) invalid();
  return row.recipientShareId;
}

function share(value: unknown, accountId: string, owned: boolean): IncomingShare | OutgoingShare {
  const row = object(value);
  exactKeys(row, owned ? [...CORE, "shareId", "recipientShareId"] : [...CORE, "shareId"]);
  if (!isV7(row.shareId)) invalid();
  const base = { shareId: row.shareId, ...core(row, accountId, owned) };
  return owned ? { ...base, recipientShareId: recipientShareId(row) } : base;
}

function grant(value: unknown, accountId: string, owned: boolean): ReceivedGrant | OwnedGrant {
  const row = object(value);
  exactKeys(row, owned ? [...GRANT, "recipientShareId"] : GRANT);
  if (
    !isV7(row.grantId) ||
    !positive(row.revision) ||
    !positive(row.keyEpoch) ||
    (row.expiresAt !== null && !positive(row.expiresAt))
  )
    invalid();
  const base = {
    grantId: row.grantId,
    ...core(row, accountId, owned),
    revision: row.revision,
    keyEpoch: row.keyEpoch,
    expiresAt: row.expiresAt as number | null,
  };
  return owned ? { ...base, recipientShareId: recipientShareId(row) } : base;
}

function page(value: unknown, keys: readonly [string, string]) {
  const body = object(value);
  exactKeys(body, [...keys, "nextCursor"]);
  const [first, second] = [body[keys[0]], body[keys[1]]];
  if (
    !Array.isArray(first) ||
    !Array.isArray(second) ||
    first.length + second.length > PAGE_SIZE ||
    (body.nextCursor !== null && !isV7(body.nextCursor))
  )
    invalid();
  return { first, second, nextCursor: body.nextCursor as string | null };
}

/** One strictly validated `POST /api/private/shares` page for `accountId`. */
export function parseSharesPage(value: unknown, accountId: string): SharesPage {
  const { first, second, nextCursor } = page(value, ["incoming", "outgoing"]);
  return {
    incoming: first.map((row) => share(row, accountId, false)),
    outgoing: second.map((row) => share(row, accountId, true) as OutgoingShare),
    nextCursor,
  };
}

/** One strictly validated `POST /api/private/grants` page for `accountId`. */
export function parseGrantsPage(value: unknown, accountId: string): GrantsPage {
  const { first, second, nextCursor } = page(value, ["received", "owned"]);
  return {
    received: first.map((row) => grant(row, accountId, false)),
    owned: second.map((row) => grant(row, accountId, true) as OwnedGrant),
    nextCursor,
  };
}

export function parseShareIdentifier(value: unknown): string {
  const body = object(value);
  exactKeys(body, ["shareId"]);
  if (!accountIdentity(body.shareId)) invalid();
  return body.shareId;
}

/**
 * Follow `nextCursor` to the end. The server orders by opaque id, so every
 * cursor must advance; a repeated or backwards cursor, or more than
 * `MAX_RELATIONSHIP_PAGES` pages, fails instead of looping.
 */
export async function readAllPages<P extends { nextCursor: string | null }>(
  read: (cursor: string | null) => Promise<P>,
): Promise<P[]> {
  const pages: P[] = [];
  let cursor: string | null = null;
  do {
    if (pages.length >= MAX_RELATIONSHIP_PAGES) throw new SharingPageLimitError();
    const next: P = await read(cursor);
    pages.push(next);
    if (next.nextCursor !== null && cursor !== null && next.nextCursor <= cursor)
      throw new Error("invalid sharing cursor");
    cursor = next.nextCursor;
  } while (cursor !== null);
  return pages;
}

/** Map a failed sharing response to its typed error, or a generic failure. */
export async function sharingFailure(response: Response): Promise<never> {
  if (response.status === 404) throw new SharingNotFoundError();
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "sharing_changed") throw new SharingChangedError();
    if (body?.error === "key_rotation_required") throw new KeyRotationRequiredError();
    if (body?.error === "already_shared") throw new AlreadySharedError();
  }
  throw new Error("sharing unavailable");
}

async function listAll<P extends { nextCursor: string | null }>(
  path: string,
  parse: (value: unknown, accountId: string) => P,
  signal?: AbortSignal,
): Promise<{ accountId: string; pages: P[] }> {
  let accountId: string | null = null;
  const pages = await readAllPages(async (cursor) => {
    const exchange = await privateExchange(`${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
      method: "POST",
      signal,
    });
    // Every page must belong to the Account the first page was read for.
    if (accountId !== null && exchange.accountId !== accountId) invalid();
    accountId = exchange.accountId;
    if (!exchange.response.ok) return sharingFailure(exchange.response);
    return parse(await exchange.response.json(), exchange.accountId);
  });
  return { accountId: accountId!, pages };
}

/** The caller's own opaque share identifier, for someone who wants to share with them. */
export async function readShareIdentifier(signal?: AbortSignal): Promise<string> {
  const response = await privateRequest("/api/private/shares/address", { method: "POST", signal });
  if (!response.ok) return sharingFailure(response);
  return parseShareIdentifier(await response.json());
}

export async function listShares(signal?: AbortSignal) {
  const { accountId, pages } = await listAll("/api/private/shares", parseSharesPage, signal);
  return {
    accountId,
    incoming: pages.flatMap((item) => item.incoming),
    outgoing: pages.flatMap((item) => item.outgoing),
  };
}

export async function listGrants(signal?: AbortSignal) {
  const { accountId, pages } = await listAll("/api/private/grants", parseGrantsPage, signal);
  return {
    accountId,
    received: pages.flatMap((item) => item.received),
    owned: pages.flatMap((item) => item.owned),
  };
}

/** Both relationship lists for one Account. */
export async function listRelationships(signal?: AbortSignal): Promise<Relationships> {
  const [shares, grants] = await Promise.all([listShares(signal), listGrants(signal)]);
  if (shares.accountId !== grants.accountId) invalid();
  return { ...shares, received: grants.received, owned: grants.owned };
}

async function mutate(path: string, method: "POST" | "PATCH" | "DELETE", body: object, signal?: AbortSignal) {
  if (!isV7(path.split("/")[4])) throw new SharingNotFoundError();
  const response = await privateRequest(path, { method, body: JSON.stringify(body), signal });
  if (!response.ok) return sharingFailure(response);
  return object(await response.json());
}

/** Accept an incoming Share. A 409 means secure access is still being prepared or the Share changed. */
export async function acceptShare(shareId: string, signal?: AbortSignal): Promise<void> {
  await mutate(`/api/private/shares/${shareId}/accept`, "POST", {}, signal);
}

export async function declineShare(shareId: string, signal?: AbortSignal): Promise<void> {
  await mutate(`/api/private/shares/${shareId}/decline`, "POST", {}, signal);
}

export async function cancelShare(shareId: string, signal?: AbortSignal): Promise<void> {
  await mutate(`/api/private/shares/${shareId}`, "DELETE", {}, signal);
}

/** Leave a received Grant at the revision the person saw. */
export async function leaveGrant(grantId: string, expectedRevision: number, signal?: AbortSignal): Promise<void> {
  await mutate(`/api/private/grants/${grantId}/leave`, "POST", { expectedRevision }, signal);
}

/** Revoke an owned Grant at the revision the Owner saw; a secure access update follows. */
export async function revokeGrant(grantId: string, expectedRevision: number, signal?: AbortSignal): Promise<void> {
  await mutate(`/api/private/grants/${grantId}`, "DELETE", { expectedRevision }, signal);
}

/**
 * Change an owned Grant's permission and/or expiry. `expiresAt: null` clears
 * the expiry; a permission change starts a secure access update.
 */
export async function changeGrant(
  grantId: string,
  expectedRevision: number,
  change: { permission?: RelationshipPermission; expiresAt?: number | null },
  signal?: AbortSignal,
): Promise<number> {
  if (change.permission === undefined && change.expiresAt === undefined) throw new Error("no Grant change");
  const result = await mutate(`/api/private/grants/${grantId}`, "PATCH", { expectedRevision, ...change }, signal);
  if (!positive(result.revision)) invalid();
  return result.revision;
}

/**
 * Invite the Account with exactly this share identifier to an owned File or
 * folder. A 404 means no other Account has that identifier (the server also
 * answers 404 for the caller's own); a 409 is `AlreadySharedError`,
 * `KeyRotationRequiredError` or `SharingChangedError`. Returns the Share's id.
 */
export async function inviteShare(
  targetId: string,
  recipientShareId: string,
  permission: RelationshipPermission,
  signal?: AbortSignal,
): Promise<string> {
  if (!isV7(targetId) || !accountIdentity(recipientShareId)) throw new SharingNotFoundError();
  const response = await privateRequest("/api/private/shares", {
    method: "PUT",
    body: JSON.stringify({ targetId, recipient: { shareId: recipientShareId }, permission }),
    signal,
  });
  if (response.status !== 201) return sharingFailure(response);
  const body = object(await response.json());
  exactKeys(body, ["shareId"]);
  if (!isV7(body.shareId)) invalid();
  return body.shareId;
}
