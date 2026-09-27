import { inspectEnvelope } from "../crypto/enc-v1";
import { encodeContext, equal, HPKE_SUITE, SYMMETRIC_SUITE, type EnvelopeContext, type EnvelopeSuite } from "../crypto/enc-v1/format";

/** Pure File-scoped statement: no parent, Directory capability, path, name or order. */
export const FILE_HEAD_DOMAIN = "mdwn/file-head/v1";
export const MAX_FILE_HEAD_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type Bytes = Uint8Array<ArrayBuffer>;

export type FileHeadErrorCode = "malformed" | "context-mismatch" | "digest-mismatch" | "invalid-signature" |
  "rollback" | "fork" | "transition-required";
export class FileHeadError extends Error {
  constructor(readonly code: FileHeadErrorCode) {
    super(`mdwn/file-head: ${code}`);
    this.name = "FileHeadError";
  }
}

export interface DirectRecipientDescriptor {
  accountId: string;
  deviceId: string;
  registryEpoch: number;
  /** Digest of the registered P-256 transport public key, not a Directory-wide target. */
  publicKeyDigest: Uint8Array;
  /** Exact direct-Grant generations for this device; overlapping Grants share one envelope. */
  grants: readonly { id: string; generation: number }[];
  envelopeDigest: Uint8Array;
}

export interface FileHeadStatement {
  ownerId: string;
  vaultId: string;
  fileId: string;
  revision: number;
  contentKey: { id: string; epoch: number };
  receivingKey: { id: string; epoch: number; publicKeyDigest: Uint8Array };
  representation: { id: string; digest: Uint8Array };
  parentEnvelopeDigest: Uint8Array;
  recipientSetVersion: number;
  recipients: readonly DirectRecipientDescriptor[];
  /** `none` is an explicit assertion that no Publication is active, not an omitted field. */
  publication: { status: "none" } | { status: "active"; id: string; representationId: string; digest: Uint8Array };
  signerDeviceId: string;
}

export interface SignedFileHead {
  bytes: Uint8Array;
  digest: Uint8Array;
  signature: Uint8Array;
}

export interface VerifiedFileHead {
  statement: FileHeadStatement;
  digest: Bytes;
}

function shape(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== fields.slice().sort().join("\0")) throw new FileHeadError("malformed");
}

function id(value: unknown): string {
  if (typeof value !== "string") throw new FileHeadError("malformed");
  const bytes = encoder.encode(value);
  try {
    if (!bytes.length || bytes.length > 256 || decoder.decode(bytes) !== value) throw new FileHeadError("malformed");
  } catch { throw new FileHeadError("malformed"); }
  return value;
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new FileHeadError("malformed");
  return value as number;
}

function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new FileHeadError("malformed");
  return value as number;
}

function copy(input: unknown, length?: number): Bytes {
  if (!(input instanceof Uint8Array) || (length !== undefined && input.length !== length)) throw new FileHeadError("malformed");
  return new Uint8Array(input);
}

function toHex(input: Uint8Array): string {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: unknown): Bytes {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new FileHeadError("malformed");
  return Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
}

function recipient(value: DirectRecipientDescriptor): DirectRecipientDescriptor {
  shape(value, ["accountId", "deviceId", "registryEpoch", "publicKeyDigest", "grants", "envelopeDigest"]);
  if (!Array.isArray(value.grants) || !value.grants.length || value.grants.length > 16) throw new FileHeadError("malformed");
  const grants = value.grants.map((grant) => {
    shape(grant, ["id", "generation"]);
    return { id: id(grant.id), generation: positive(grant.generation) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (grants.some((grant, index) => index > 0 && grant.id === grants[index - 1].id)) throw new FileHeadError("malformed");
  return { accountId: id(value.accountId), deviceId: id(value.deviceId),
    registryEpoch: nonnegative(value.registryEpoch), publicKeyDigest: copy(value.publicKeyDigest, 32),
    grants, envelopeDigest: copy(value.envelopeDigest, 32) };
}

function normalized(statement: FileHeadStatement): FileHeadStatement {
  shape(statement, ["ownerId", "vaultId", "fileId", "revision", "contentKey", "receivingKey",
    "representation", "parentEnvelopeDigest", "recipientSetVersion", "recipients", "publication", "signerDeviceId"]);
  shape(statement.contentKey, ["id", "epoch"]);
  shape(statement.receivingKey, ["id", "epoch", "publicKeyDigest"]);
  shape(statement.representation, ["id", "digest"]);
  if (!Array.isArray(statement.recipients) || statement.recipients.length > 256) throw new FileHeadError("malformed");
  const recipients = statement.recipients.map(recipient).sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
  if (new Set(recipients.map((item) => item.deviceId)).size !== recipients.length) throw new FileHeadError("malformed");
  const publication = statement.publication;
  if (!publication || publication.status === "none") {
    shape(publication, ["status"]);
    if (publication.status !== "none") throw new FileHeadError("malformed");
  } else {
    shape(publication, ["status", "id", "representationId", "digest"]);
    if (publication.status !== "active") throw new FileHeadError("malformed");
  }
  const ownerId = id(statement.ownerId);
  if (id(statement.vaultId) !== ownerId) throw new FileHeadError("context-mismatch");
  return {
    ownerId, vaultId: ownerId, fileId: id(statement.fileId), revision: positive(statement.revision),
    contentKey: { id: id(statement.contentKey.id), epoch: positive(statement.contentKey.epoch) },
    receivingKey: { id: id(statement.receivingKey.id), epoch: positive(statement.receivingKey.epoch),
      publicKeyDigest: copy(statement.receivingKey.publicKeyDigest, 32) },
    representation: { id: id(statement.representation.id), digest: copy(statement.representation.digest, 32) },
    parentEnvelopeDigest: copy(statement.parentEnvelopeDigest, 32),
    recipientSetVersion: positive(statement.recipientSetVersion), recipients,
    publication: publication.status === "none" ? { status: "none" } :
      { status: "active", id: id(publication.id), representationId: id(publication.representationId), digest: copy(publication.digest, 32) },
    signerDeviceId: id(statement.signerDeviceId),
  };
}

/** Deterministic JSON array, strict fields and sizes; input is snapshotted synchronously. */
export function canonicalFileHeadBytes(input: FileHeadStatement): Bytes {
  const s = normalized(input);
  const bytes = encoder.encode(JSON.stringify([
    FILE_HEAD_DOMAIN, s.ownerId, s.vaultId, s.fileId, s.revision,
    s.contentKey.id, s.contentKey.epoch, s.receivingKey.id, s.receivingKey.epoch, toHex(s.receivingKey.publicKeyDigest),
    s.representation.id, toHex(s.representation.digest), toHex(s.parentEnvelopeDigest), s.recipientSetVersion,
    s.recipients.map((r) => [r.accountId, r.deviceId, r.registryEpoch, toHex(r.publicKeyDigest),
      r.grants.map((g) => [g.id, g.generation]), toHex(r.envelopeDigest)]),
    s.publication.status === "none" ? ["none"] :
      ["active", s.publication.id, s.publication.representationId, toHex(s.publication.digest)],
    s.signerDeviceId,
  ]));
  if (bytes.length > MAX_FILE_HEAD_BYTES) throw new FileHeadError("malformed");
  return bytes;
}

/** Rejects non-canonical encodings, duplicate descriptors, extra fields and unsafe counters. */
export function parseFileHeadBytes(input: Uint8Array): FileHeadStatement {
  const bytes = copy(input);
  if (!bytes.length || bytes.length > MAX_FILE_HEAD_BYTES) throw new FileHeadError("malformed");
  try {
    const a: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(a) || a.length !== 17 || a[0] !== FILE_HEAD_DOMAIN ||
        !Array.isArray(a[14]) || !Array.isArray(a[15])) throw new FileHeadError("malformed");
    const recipients: DirectRecipientDescriptor[] = a[14].map((r: unknown) => {
      if (!Array.isArray(r) || r.length !== 6 || !Array.isArray(r[4])) throw new FileHeadError("malformed");
      return { accountId: r[0], deviceId: r[1], registryEpoch: r[2], publicKeyDigest: fromHex(r[3]),
        grants: r[4].map((g: unknown) => {
          if (!Array.isArray(g) || g.length !== 2) throw new FileHeadError("malformed");
          return { id: g[0], generation: g[1] };
        }), envelopeDigest: fromHex(r[5]) };
    });
    const p = a[15];
    const publication = p.length === 1 && p[0] === "none" ? { status: "none" as const } :
      p.length === 4 && p[0] === "active" ?
        { status: "active" as const, id: p[1], representationId: p[2], digest: fromHex(p[3]) } : null;
    if (!publication) throw new FileHeadError("malformed");
    const statement: FileHeadStatement = {
      ownerId: a[1], vaultId: a[2], fileId: a[3], revision: a[4],
      contentKey: { id: a[5], epoch: a[6] }, receivingKey: { id: a[7], epoch: a[8], publicKeyDigest: fromHex(a[9]) },
      representation: { id: a[10], digest: fromHex(a[11]) }, parentEnvelopeDigest: fromHex(a[12]),
      recipientSetVersion: a[13], recipients, publication, signerDeviceId: a[16],
    };
    if (!equal(canonicalFileHeadBytes(statement), bytes)) throw new FileHeadError("malformed");
    return normalized(statement);
  } catch { throw new FileHeadError("malformed"); }
}

async function hash(bytes: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

/** A valid signature authenticates bytes only, never service/Grant authorization. */
export async function signFileHead(input: FileHeadStatement, assertionPrivateKey: CryptoKey): Promise<SignedFileHead> {
  const bytes = canonicalFileHeadBytes(input); // snapshot everything before the first await
  if (!assertionPrivateKey || assertionPrivateKey.type !== "private" || assertionPrivateKey.extractable ||
      assertionPrivateKey.algorithm.name !== "ECDSA" ||
      !("namedCurve" in assertionPrivateKey.algorithm) || assertionPrivateKey.algorithm.namedCurve !== "P-256" ||
      !assertionPrivateKey.usages.includes("sign")) throw new FileHeadError("malformed");
  return { bytes, digest: await hash(bytes), signature: new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, assertionPrivateKey, bytes)) };
}

export async function verifyFileHead(head: SignedFileHead, trusted: {
  ownerId: string; vaultId: string; fileId: string; signerDeviceId: string;
  publicKey: Uint8Array; revision?: number; digest?: Uint8Array;
}): Promise<VerifiedFileHead> {
  const bytes = copy(head.bytes);
  const digest = copy(head.digest, 32);
  const signature = copy(head.signature, 64);
  const publicBytes = copy(trusted.publicKey, 65);
  const expectedDigest = trusted.digest === undefined ? undefined : copy(trusted.digest, 32);
  const expected = { ownerId: id(trusted.ownerId), vaultId: id(trusted.vaultId), fileId: id(trusted.fileId),
    signerDeviceId: id(trusted.signerDeviceId), revision: trusted.revision };
  const statement = parseFileHeadBytes(bytes);
  if (statement.ownerId !== expected.ownerId || statement.vaultId !== expected.vaultId ||
      statement.fileId !== expected.fileId || statement.signerDeviceId !== expected.signerDeviceId ||
      (expected.revision !== undefined && statement.revision !== expected.revision)) throw new FileHeadError("context-mismatch");
  if (!equal(await hash(bytes), digest) || (expectedDigest && !equal(expectedDigest, digest))) {
    throw new FileHeadError("digest-mismatch");
  }
  try {
    if (publicBytes[0] !== 4) throw new FileHeadError("invalid-signature");
    const publicKey = await crypto.subtle.importKey("raw", publicBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, bytes)) {
      throw new FileHeadError("invalid-signature");
    }
  } catch { throw new FileHeadError("invalid-signature"); }
  return { statement, digest };
}

/** These checks validate exact returned bytes, not service authorization or HPKE plaintext equality. */
async function matchDigest(actual: Uint8Array, expected: Uint8Array): Promise<void> {
  if (!equal(await hash(actual), expected)) throw new FileHeadError("digest-mismatch");
}

async function matchEnvelope(input: Uint8Array, digest: Uint8Array, suite: EnvelopeSuite,
  context: EnvelopeContext): Promise<void> {
  const envelope = copy(input);
  let actual: ReturnType<typeof inspectEnvelope>;
  try { actual = inspectEnvelope(envelope); }
  catch { throw new FileHeadError("malformed"); }
  if (actual.suite !== suite || !equal(encodeContext(actual.context), encodeContext(context))) {
    throw new FileHeadError("context-mismatch");
  }
  await matchDigest(envelope, digest);
}

export async function verifyFileReceivingTarget(head: VerifiedFileHead, publicKey: Uint8Array): Promise<void> {
  const target = copy(publicKey);
  const expected = copy(head.statement.receivingKey.publicKeyDigest, 32);
  if (target.length !== 65 || target[0] !== 4) throw new FileHeadError("malformed");
  try { await crypto.subtle.importKey("raw", target, { name: "ECDH", namedCurve: "P-256" }, false, []); }
  catch { throw new FileHeadError("malformed"); }
  await matchDigest(target, expected);
}

function fileKeyContext(s: FileHeadStatement, purpose: "file-content" | "file-content-key" | "grant",
  recipientId?: string): EnvelopeContext {
  return { purpose, vaultId: s.vaultId, objectId: s.fileId, keyId: s.contentKey.id,
    keyEpoch: s.contentKey.epoch, revision: s.revision,
    ...(recipientId === undefined ? {} : { recipientId }) };
}

export async function verifyFileRepresentation(head: VerifiedFileHead, representationId: string, envelope: Uint8Array): Promise<void> {
  const s = head.statement;
  if (id(representationId) !== s.representation.id) throw new FileHeadError("context-mismatch");
  await matchEnvelope(envelope, copy(s.representation.digest, 32), SYMMETRIC_SUITE, fileKeyContext(s, "file-content"));
}

export async function verifyFileParentEnvelope(head: VerifiedFileHead, envelope: Uint8Array): Promise<void> {
  const s = head.statement;
  await matchEnvelope(envelope, copy(s.parentEnvelopeDigest, 32), HPKE_SUITE,
    fileKeyContext(s, "file-content-key", s.receivingKey.id));
}

export async function verifyDirectFileRecipientEnvelope(head: VerifiedFileHead, accountId: string, deviceId: string,
  publicKey: Uint8Array, envelope: Uint8Array): Promise<void> {
  const s = normalized(head.statement);
  const recipient = s.recipients.find((item) => item.accountId === id(accountId) && item.deviceId === id(deviceId));
  if (!recipient) throw new FileHeadError("context-mismatch");
  const key = copy(publicKey);
  const encrypted = copy(envelope);
  const expectedKeyDigest = copy(recipient.publicKeyDigest, 32);
  const expectedEnvelopeDigest = copy(recipient.envelopeDigest, 32);
  const context = fileKeyContext(s, "grant", recipient.deviceId);
  if (key.length !== 65 || key[0] !== 4) throw new FileHeadError("malformed");
  try { await crypto.subtle.importKey("raw", key, { name: "ECDH", namedCurve: "P-256" }, false, []); }
  catch { throw new FileHeadError("malformed"); }
  await matchDigest(key, expectedKeyDigest);
  await matchEnvelope(encrypted, expectedEnvelopeDigest, HPKE_SUITE, context);
}

/** `expected` must come from current authorized Grants + registry, not from the signed head. */
export function assertExactFileRecipientDescriptors(head: VerifiedFileHead,
  expected: readonly Omit<DirectRecipientDescriptor, "envelopeDigest">[]): void {
  if (!Array.isArray(expected) || expected.length > 256) throw new FileHeadError("malformed");
  const normalizedExpected = expected.map((item) => recipient({ ...item, envelopeDigest: new Uint8Array(32) }))
    .sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 :
      a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
  if (new Set(normalizedExpected.map((item) => item.deviceId)).size !== normalizedExpected.length) {
    throw new FileHeadError("malformed");
  }
  const descriptor = (r: Omit<DirectRecipientDescriptor, "envelopeDigest">) =>
    [r.accountId, r.deviceId, r.registryEpoch, toHex(r.publicKeyDigest), r.grants.map((g) => [g.id, g.generation])];
  if (JSON.stringify(normalizedExpected.map(descriptor)) !== JSON.stringify(head.statement.recipients.map(descriptor))) {
    throw new FileHeadError("context-mismatch");
  }
}

export async function verifyFilePublicationRepresentation(head: VerifiedFileHead, representationId: string,
  envelope: Uint8Array): Promise<void> {
  const s = head.statement;
  if (s.publication.status !== "active" || id(representationId) !== s.publication.representationId) {
    throw new FileHeadError("context-mismatch");
  }
  const encrypted = copy(envelope);
  let header: ReturnType<typeof inspectEnvelope>;
  try { header = inspectEnvelope(encrypted); } catch { throw new FileHeadError("malformed"); }
  if (header.suite !== SYMMETRIC_SUITE || header.context.purpose !== "public-representation" ||
      header.context.vaultId !== s.vaultId || header.context.objectId !== s.fileId ||
      header.context.revision !== s.revision || header.context.publicationId !== s.publication.id ||
      header.context.recipientId !== undefined) throw new FileHeadError("context-mismatch");
  await matchDigest(encrypted, copy(s.publication.digest, 32));
}

/** The caller must first verify signatures and retain the previous checkpoint independently.
 * `authenticatedSameRevision` is an assertion by the caller about a guarded transition,
 * NOT a claim that this pure module can establish server permission or rotation state.
 */
export function assertFileHeadAdvance(previous: VerifiedFileHead, next: VerifiedFileHead, options: {
  authenticatedSameRevision?: "receiving-rotation" | "recipient-set-update" | "both";
} = {}): void {
  const before = normalized(previous.statement);
  const after = normalized(next.statement);
  const priorDigest = copy(previous.digest, 32);
  const nextDigest = copy(next.digest, 32);
  if (before.ownerId !== after.ownerId || before.vaultId !== after.vaultId || before.fileId !== after.fileId) {
    throw new FileHeadError("context-mismatch");
  }
  if (after.revision < before.revision || after.contentKey.epoch < before.contentKey.epoch ||
      after.receivingKey.epoch < before.receivingKey.epoch || after.recipientSetVersion < before.recipientSetVersion) {
    throw new FileHeadError("rollback");
  }
  const receivingChanged = after.receivingKey.epoch > before.receivingKey.epoch;
  const recipientsChanged = after.recipientSetVersion > before.recipientSetVersion;
  if (after.revision === before.revision && !receivingChanged && !recipientsChanged &&
      !equal(priorDigest, nextDigest)) throw new FileHeadError("fork");
  if (!receivingChanged && (before.receivingKey.id !== after.receivingKey.id ||
      !equal(before.receivingKey.publicKeyDigest, after.receivingKey.publicKeyDigest))) {
    throw new FileHeadError("transition-required");
  }
  if (receivingChanged && (before.receivingKey.id === after.receivingKey.id ||
      equal(before.receivingKey.publicKeyDigest, after.receivingKey.publicKeyDigest))) {
    throw new FileHeadError("transition-required");
  }
  const recipientCommitment = (s: FileHeadStatement, includeEnvelopes: boolean) => JSON.stringify(s.recipients.map((r) =>
    [r.accountId, r.deviceId, r.registryEpoch, toHex(r.publicKeyDigest),
      r.grants.map((g) => [g.id, g.generation]), ...(includeEnvelopes ? [toHex(r.envelopeDigest)] : [])]));
  const descriptorsEqual = recipientCommitment(before, false) === recipientCommitment(after, false);
  const commitmentsEqual = recipientCommitment(before, true) === recipientCommitment(after, true);
  if (after.revision > before.revision) {
    // A normal save re-envelopes the fresh File key to the SAME authorized devices,
    // without bumping the recipient-set version. Only descriptor changes require it.
    if ((!recipientsChanged && !descriptorsEqual) || (recipientsChanged && descriptorsEqual)) {
      throw new FileHeadError("transition-required");
    }
    if (after.contentKey.epoch <= before.contentKey.epoch) throw new FileHeadError("rollback");
    if (after.contentKey.id === before.contentKey.id || after.representation.id === before.representation.id ||
        equal(after.representation.digest, before.representation.digest) ||
        equal(after.parentEnvelopeDigest, before.parentEnvelopeDigest) ||
        after.recipients.some((recipient) => before.recipients.some((old) => old.deviceId === recipient.deviceId &&
          equal(old.envelopeDigest, recipient.envelopeDigest)))) throw new FileHeadError("transition-required");
    return;
  }
  if ((!recipientsChanged && !commitmentsEqual) || (recipientsChanged && commitmentsEqual)) {
    throw new FileHeadError("transition-required");
  }
  if (!receivingChanged && !recipientsChanged) {
    if (!equal(priorDigest, nextDigest)) throw new FileHeadError("fork");
    return;
  }
  const transition = receivingChanged ? (recipientsChanged ? "both" : "receiving-rotation") : "recipient-set-update";
  if (options.authenticatedSameRevision !== transition ||
      after.contentKey.epoch !== before.contentKey.epoch || after.contentKey.id !== before.contentKey.id ||
      after.representation.id !== before.representation.id ||
      !equal(after.representation.digest, before.representation.digest) ||
      JSON.stringify(before.publication) !== JSON.stringify(after.publication) ||
      (receivingChanged ? equal(before.parentEnvelopeDigest, after.parentEnvelopeDigest) :
        !equal(before.parentEnvelopeDigest, after.parentEnvelopeDigest))) {
    throw new FileHeadError("transition-required");
  }
}
