import { isMap, isScalar, parseDocument } from "yaml";

import { openForRecipient, sealToRecipient, type EnvelopeContext } from "~/shared/crypto/enc-v1";
import { importPublicationPublicKey, publicationRecipientId } from "./capability";

/**
 * Public representation and author-declaration envelopes (ticket 22).
 *
 * A Public representation is one HPKE `public-representation` envelope to the
 * active link's public key. Its plaintext is the presentation payload: the
 * optional title from YAML front matter and the Markdown body with the raw
 * front matter removed. Any authorized File editor builds it from the saved
 * source without the URL fragment. The envelope context never names the Owner,
 * the File, or its Vault: its scope and object are the logical Publication.
 */

export const MAX_PUBLIC_REPRESENTATION_BYTES = 524_288;
export const MAX_AUTHOR_DECLARATION_BYTES = 4_096;
export const MAX_PUBLICATION_AUTHORS = 20;
const MAX_PSEUDONYM_CHARS = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PRESENTATION_MAGIC = encoder.encode("mdwn/public-presentation/v1\0");
const AUTHOR_MAGIC = encoder.encode("mdwn/publication-author/v1\0");

export type PublicPresentation = { title: string | null; markdown: string };

const OPENING = /^﻿?---[ \t]*(?:\r\n|\n|\r)/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Strip a leading YAML front-matter block without rewriting the Markdown body.
 * Parse the whole mapping before selecting its title: a title-looking line can
 * be part of another field's multiline string, not a public title.
 */
export function publicPresentation(source: string): PublicPresentation {
  const opening = OPENING.exec(source);
  if (!opening) return { title: null, markdown: source };
  const lines: string[] = [];
  const newline = /\r\n|\n|\r/g;
  let offset = opening[0].length;
  while (true) {
    newline.lastIndex = offset;
    const end = newline.exec(source);
    const line = source.slice(offset, end?.index ?? source.length);
    if (CLOSING.test(line)) {
      return { title: frontMatterTitle(lines), markdown: end ? source.slice(newline.lastIndex) : "" };
    }
    if (!end) return { title: null, markdown: source };
    lines.push(line);
    offset = newline.lastIndex;
  }
}

function frontMatterTitle(lines: readonly string[]): string | null {
  try {
    const document = parseDocument(lines.join("\n"), { version: "1.2", strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return null;
    // Inspect the scalar directly, never convert the document to JS or expand
    // aliases. An alias must not promote another private field into the title.
    const title = document.get("title", true);
    return isScalar(title) && typeof title.value === "string" && title.value ? title.value : null;
  } catch {
    return null;
  }
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Canonical presentation payload; an empty title is not representable. */
export function encodePublicPresentation(presentation: PublicPresentation): Uint8Array<ArrayBuffer> {
  if (
    !presentation ||
    typeof presentation.markdown !== "string" ||
    (presentation.title !== null && (typeof presentation.title !== "string" || !presentation.title))
  ) {
    throw new Error("invalid public presentation");
  }
  const title = encoder.encode(presentation.title ?? "");
  const markdown = encoder.encode(presentation.markdown);
  // YAML escapes may expand a valid File source. Presentation framing and the
  // final encrypted envelope have their own bound, not the private source limit.
  if (PRESENTATION_MAGIC.length + 8 + title.length + markdown.length > MAX_PUBLIC_REPRESENTATION_BYTES) {
    throw new Error("invalid public presentation");
  }
  return concat(PRESENTATION_MAGIC, u32(title.length), title, u32(markdown.length), markdown);
}

export function decodePublicPresentation(input: Uint8Array): PublicPresentation {
  if (input.byteLength > MAX_PUBLIC_REPRESENTATION_BYTES) throw new Error("invalid public presentation");
  const bytes = new Uint8Array(input);
  const view = new DataView(bytes.buffer);
  const magic = PRESENTATION_MAGIC.length;
  if (bytes.length < magic + 8 || PRESENTATION_MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("invalid public presentation");
  }
  const titleLength = view.getUint32(magic);
  if (magic + 8 + titleLength > bytes.length) throw new Error("invalid public presentation");
  const markdownLength = view.getUint32(magic + 4 + titleLength);
  if (magic + 8 + titleLength + markdownLength !== bytes.length) throw new Error("invalid public presentation");
  try {
    const title = decoder.decode(bytes.slice(magic + 4, magic + 4 + titleLength));
    const markdown = decoder.decode(bytes.slice(magic + 8 + titleLength));
    return { title: title || null, markdown };
  } catch {
    throw new Error("invalid public presentation");
  }
}

export type PublicRepresentationBinding = {
  publicationId: string;
  linkId: string;
  publicKey: Uint8Array;
  revision: number;
};

/** The logical Publication is both scope and object; the link is the protecting key. */
export function publicRepresentationContext(binding: PublicRepresentationBinding): EnvelopeContext {
  return {
    purpose: "public-representation",
    vaultId: binding.publicationId,
    objectId: binding.publicationId,
    keyId: binding.linkId,
    keyEpoch: 1,
    revision: binding.revision,
    recipientId: publicationRecipientId(binding.publicKey),
    publicationId: binding.publicationId,
  };
}

/** Editors encrypt to the stored public key; the fragment is never needed. */
export async function sealPublicRepresentation(
  binding: PublicRepresentationBinding,
  presentation: PublicPresentation,
): Promise<Uint8Array<ArrayBuffer>> {
  const envelope = await sealToRecipient(
    encodePublicPresentation(presentation),
    await importPublicationPublicKey(binding.publicKey),
    publicRepresentationContext(binding),
  );
  if (envelope.length > MAX_PUBLIC_REPRESENTATION_BYTES) throw new Error("public representation too large");
  return envelope;
}

export async function openPublicRepresentation(
  envelope: Uint8Array,
  keyPair: CryptoKeyPair,
  binding: PublicRepresentationBinding,
): Promise<PublicPresentation> {
  if (envelope.length > MAX_PUBLIC_REPRESENTATION_BYTES) throw new Error("public representation too large");
  return decodePublicPresentation(
    await openForRecipient(envelope, keyPair, { context: publicRepresentationContext(binding) }),
  );
}

export type AuthorDeclarationBinding = {
  publicationId: string;
  linkId: string;
  publicKey: Uint8Array;
  declarationId: string;
  revision: number;
};

/** An author's own pseudonym declaration, readable only with the Public link. */
export function authorDeclarationContext(binding: AuthorDeclarationBinding): EnvelopeContext {
  return {
    purpose: "publication-attribution",
    vaultId: binding.publicationId,
    objectId: binding.declarationId,
    keyId: binding.linkId,
    keyEpoch: 1,
    revision: binding.revision,
    recipientId: publicationRecipientId(binding.publicKey),
    publicationId: binding.publicationId,
  };
}

function encodeAuthor(pseudonym: string): Uint8Array<ArrayBuffer> {
  const bytes = typeof pseudonym === "string" ? encoder.encode(pseudonym) : new Uint8Array();
  if (!bytes.length || Array.from(pseudonym).length > MAX_PSEUDONYM_CHARS || bytes.length > 1024) {
    throw new Error("invalid_pseudonym");
  }
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, bytes.length);
  return concat(AUTHOR_MAGIC, length, bytes);
}

function decodeAuthor(input: Uint8Array): string {
  const bytes = new Uint8Array(input);
  const magic = AUTHOR_MAGIC.length;
  if (
    bytes.length < magic + 3 ||
    AUTHOR_MAGIC.some((byte, index) => bytes[index] !== byte) ||
    new DataView(bytes.buffer).getUint16(magic) !== bytes.length - magic - 2
  )
    throw new Error("invalid_pseudonym");
  try {
    const pseudonym = decoder.decode(bytes.slice(magic + 2));
    encodeAuthor(pseudonym);
    return pseudonym;
  } catch {
    throw new Error("invalid_pseudonym");
  }
}

export async function sealAuthorDeclaration(
  binding: AuthorDeclarationBinding,
  pseudonym: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const envelope = await sealToRecipient(
    encodeAuthor(pseudonym),
    await importPublicationPublicKey(binding.publicKey),
    authorDeclarationContext(binding),
  );
  if (envelope.length > MAX_AUTHOR_DECLARATION_BYTES) throw new Error("invalid_pseudonym");
  return envelope;
}

export async function openAuthorDeclaration(
  envelope: Uint8Array,
  keyPair: CryptoKeyPair,
  binding: AuthorDeclarationBinding,
): Promise<string> {
  if (envelope.length > MAX_AUTHOR_DECLARATION_BYTES) throw new Error("invalid_pseudonym");
  return decodeAuthor(await openForRecipient(envelope, keyPair, { context: authorDeclarationContext(binding) }));
}
