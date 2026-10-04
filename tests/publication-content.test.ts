import { describe, expect, it } from "vitest";

import { inspectEnvelope, sealToRecipient } from "../app/crypto/enc-v1";
import { FILE_SOURCE_LIMIT } from "../app/crypto/file-source";
import {
  createPublicationKeyPair,
  formatPublicationFragment,
  importPublicationKeyPair,
  isPublicationIdentifier,
  newPublicationIdentifier,
  parsePublicationFragment,
  publicationRecipientId,
  publicLinkUrl,
} from "../app/publications/capability";
import {
  authorDeclarationContext,
  decodePublicPresentation,
  encodePublicPresentation,
  MAX_PUBLIC_REPRESENTATION_BYTES,
  openAuthorDeclaration,
  openPublicRepresentation,
  publicPresentation,
  publicRepresentationContext,
  sealAuthorDeclaration,
  sealPublicRepresentation,
} from "../app/publications/content";

const publicationId = "HyYtNDtCSVBXXmVsc3qBiI-WnaSrsrnAx87V3OPq8fg";
const linkId = "PkVMU1phaG92fYSLkpmgp661vMPK0djf5u30-wIJEBc";
const declarationId = "XWRrcnmAh46VnKOqsbi_xs3U2-Lp8Pf-BQwTGiEoLzY";

describe("Public presentation", () => {
  it("passes Markdown without front matter through unchanged and without a title", () => {
    expect(publicPresentation("# Heading\n\nBody")).toEqual({ title: null, markdown: "# Heading\n\nBody" });
    expect(publicPresentation("")).toEqual({ title: null, markdown: "" });
  });

  it("strips raw front matter and keeps only its title", () => {
    const source = "---\ntitle: Diet plan\ndate: 2026-01-02\nprivate: never shown\n---\n# Week one\n\nEat well.";
    expect(publicPresentation(source)).toEqual({ title: "Diet plan", markdown: "# Week one\n\nEat well." });
  });

  it("accepts CRLF, a BOM, the YAML document-end marker and an untitled block", () => {
    expect(publicPresentation("﻿---\r\ntitle: Windows\r\n...\r\nBody")).toEqual({ title: "Windows", markdown: "Body" });
    expect(publicPresentation("---\ntags: [a, b]\n---\nBody")).toEqual({ title: null, markdown: "Body" });
    expect(publicPresentation("---\n---\n")).toEqual({ title: null, markdown: "" });
  });

  it.each(["\n", "\r\n", "\r"])("strips front matter with %j line endings without rewriting the body", (newline) => {
    const body = `# Public${newline}${newline}Body${newline}`;
    expect(publicPresentation(["---", "title: Public", "private: never public", "---", body].join(newline)))
      .toEqual({ title: "Public", markdown: body });
  });

  it("keeps only a real top-level title, never text from another YAML value", () => {
    for (const yaml of [
      'private: "note\ntitle: SECRET\nend"',
      "private: 'note\ntitle: SECRET\nend'",
      "private: |\n  title: SECRET",
      "private:\n  title: SECRET",
      "title: Public\n  private: SECRET",
      "title: First\ntitle: SECRET",
    ]) {
      expect(publicPresentation(`---\n${yaml}\n---\nBody`), yaml).toEqual({ title: null, markdown: "Body" });
    }
  });

  it.each([
    ['"title": Valid title', "Valid title"],
    ["'title': Valid title", "Valid title"],
    ["  title: Indented root", "Indented root"],
    ["title: &anchor Anchored title", "Anchored title"],
    ["title: !!str 123", "123"],
    ["title: |-\n  Literal\n  title", "Literal\ntitle"],
    ["title: >-\n  Folded\n  title", "Folded title"],
    ['title: "Multi\n  line"', "Multi line"],
  ])("reads a valid YAML string title from %j", (yaml, expected) => {
    expect(publicPresentation(`---\n${yaml}\n---\nBody`)).toEqual({ title: expected, markdown: "Body" });
  });

  it("treats an unterminated leading block as ordinary Markdown", () => {
    const source = "---\ntitle: Not front matter\n\nBody";
    expect(publicPresentation(source)).toEqual({ title: null, markdown: source });
    expect(publicPresentation("text\n---\ntitle: x\n---\n")).toEqual({ title: null, markdown: "text\n---\ntitle: x\n---\n" });
  });

  it("parses quoted, commented and folded title scalars conservatively", () => {
    const title = (line: string) => publicPresentation(`---\n${line}\n---\nBody`).title;
    expect(title('title: "Quoted \\"title\\" \\u00e9"')).toBe('Quoted "title" é');
    expect(title("title: 'It''s single'")).toBe("It's single");
    expect(title("title: Plain # comment")).toBe("Plain");
    expect(title("title: C# notes")).toBe("C# notes");
    expect(title("title: First line\n  continues here")).toBe("First line continues here");
    expect(title("title:   Spaced   ")).toBe("Spaced");
    expect(title("title: Ünïcode ☕")).toBe("Ünïcode ☕");
  });

  it("never renders structured, empty, null or nested title values", () => {
    const title = (line: string) => publicPresentation(`---\n${line}\n---\nBody`).title;
    for (const line of ["title:", "title: [a, b]", "title: {a: b}",
      "title: *alias", "private: &secret SECRET\ntitle: *secret", "title: !tag value", "title: ~", "title: null", "title: \"unterminated",
      "title: 'unterminated", "title: \"bad \\q escape\"", "subtitle: nope", "title:no-space",
      "Title: case-sensitive"]) {
      expect(title(line), line).toBeNull();
    }
  });

  it("round-trips the canonical payload and rejects malformed or oversized framing", () => {
    for (const presentation of [{ title: null, markdown: "" }, { title: "Title 🌍", markdown: "Body\n" }]) {
      expect(decodePublicPresentation(encodePublicPresentation(presentation))).toEqual(presentation);
    }
    const encoded = encodePublicPresentation({ title: "T", markdown: "Body" });
    expect(() => decodePublicPresentation(encoded.slice(0, -1))).toThrow();
    expect(() => decodePublicPresentation(new Uint8Array([...encoded, 0]))).toThrow();
    const wrongMagic = new Uint8Array(encoded); wrongMagic[0] ^= 1;
    expect(() => decodePublicPresentation(wrongMagic)).toThrow();
    expect(() => encodePublicPresentation({ title: "", markdown: "x" })).toThrow();
    expect(() => encodePublicPresentation({ title: null, markdown: "a".repeat(MAX_PUBLIC_REPRESENTATION_BYTES + 1) })).toThrow();
    expect(encodePublicPresentation({ title: null, markdown: "a".repeat(FILE_SOURCE_LIMIT) }).length)
      .toBeLessThan(MAX_PUBLIC_REPRESENTATION_BYTES);
  });
});

describe("Publication capability", () => {
  it("generates canonical 256-bit base64url identifiers", () => {
    const ids = new Set(Array.from({ length: 32 }, newPublicationIdentifier));
    expect(ids.size).toBe(32);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isPublicationIdentifier(id)).toBe(true);
    }
    // 43 base64url characters carry 258 bits: only canonical encodings of 32 bytes are accepted.
    expect(isPublicationIdentifier(`${"A".repeat(42)}B`)).toBe(false);
    expect(isPublicationIdentifier("A".repeat(42))).toBe(false);
    expect(isPublicationIdentifier(`${"A".repeat(42)}=`)).toBe(false);
    expect(isPublicationIdentifier("0198c0de-0000-7000-8000-000000000001")).toBe(false);
  });

  it("keeps only a versioned key after # and rejects other fragments without echoing them", async () => {
    const keys = await createPublicationKeyPair();
    const fragment = formatPublicationFragment(keys.privateKey);
    expect(fragment).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    expect(parsePublicationFragment(`#${fragment}`)).toEqual(keys.privateKey);
    expect(parsePublicationFragment(fragment)).toEqual(keys.privateKey);
    for (const invalid of ["", "#", "#v2.AAAA", `#v1.${"A".repeat(42)}`, `#${fragment}x`, `#V1.${fragment.slice(3)}`]) {
      expect(parsePublicationFragment(invalid)).toBeNull();
    }
    const url = publicLinkUrl("https://mdwn.test", linkId, keys.privateKey);
    expect(url).toBe(`https://mdwn.test/p/${linkId}#${fragment}`);
    expect(new URL(url).pathname).toBe(`/p/${linkId}`);
  });

  it("re-imports the fragment key only with its matching public key", async () => {
    const keys = await createPublicationKeyPair();
    expect(keys.publicKey).toHaveLength(65);
    expect(keys.publicKey[0]).toBe(4);
    const pair = await importPublicationKeyPair(keys.privateKey, keys.publicKey);
    expect(pair.privateKey.extractable).toBe(false);
    expect(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))).toEqual(keys.publicKey);
    expect(publicationRecipientId(keys.publicKey)).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });

  it("never opens a representation through a substituted service public key", async () => {
    const keys = await createPublicationKeyPair(), substitute = await createPublicationKeyPair();
    const binding = { publicationId, linkId, publicKey: keys.publicKey, revision: 1 };
    const envelope = await sealPublicRepresentation(binding, { title: null, markdown: "Body" });
    // Some engines reject the mismatched JWK pair at import; any that accept it still cannot decrypt.
    await expect((async () => openPublicRepresentation(envelope,
      await importPublicationKeyPair(keys.privateKey, substitute.publicKey), { ...binding, publicKey: substitute.publicKey }))())
      .rejects.toThrow();
  });
});

describe("Public representation envelopes", () => {
  async function sealed(markdown = "---\ntitle: Live\n---\nBody") {
    const keys = await createPublicationKeyPair();
    const context = { publicationId, linkId, publicKey: keys.publicKey, revision: 3 };
    const envelope = await sealPublicRepresentation(context, publicPresentation(markdown));
    return { keys, context, envelope, pair: await importPublicationKeyPair(keys.privateKey, keys.publicKey) };
  }

  it("binds an HPKE envelope to the logical Publication, link, recipient key and revision only", async () => {
    const { keys, context, envelope, pair } = await sealed();
    const header = inspectEnvelope(envelope);
    expect(header.suite).toBe("HPKE-P256/HKDF-SHA-256/AES-256-GCM");
    expect(header.context).toEqual({ purpose: "public-representation", vaultId: publicationId, objectId: publicationId,
      keyId: linkId, keyEpoch: 1, revision: 3, recipientId: publicationRecipientId(keys.publicKey), publicationId });
    expect(header.context).toEqual(publicRepresentationContext(context));
    expect(await openPublicRepresentation(envelope, pair, context)).toEqual({ title: "Live", markdown: "Body" });
  });

  it("rejects another link, Publication, revision, key or purpose", async () => {
    const { keys, context, envelope, pair } = await sealed();
    await expect(openPublicRepresentation(envelope, pair, { ...context, linkId: declarationId })).rejects.toThrow();
    await expect(openPublicRepresentation(envelope, pair, { ...context, publicationId: declarationId })).rejects.toThrow();
    await expect(openPublicRepresentation(envelope, pair, { ...context, revision: 4 })).rejects.toThrow();
    const other = await createPublicationKeyPair();
    await expect(openPublicRepresentation(envelope, await importPublicationKeyPair(other.privateKey, other.publicKey),
      { ...context, publicKey: other.publicKey })).rejects.toThrow();
    // A crossed Publication envelope (author declaration) never opens as presentation.
    const declaration = await sealAuthorDeclaration({ publicationId, linkId, publicKey: keys.publicKey,
      declarationId: publicationId, revision: 3 }, "Member Pine");
    await expect(openPublicRepresentation(declaration, pair, context)).rejects.toThrow();
  });

  it("rejects a forged envelope with valid framing but the wrong payload format", async () => {
    const { keys, context, pair } = await sealed();
    const forged = await sealToRecipient(new TextEncoder().encode("raw markdown"), pair.publicKey,
      publicRepresentationContext(context));
    expect(inspectEnvelope(forged).context.recipientId).toBe(publicationRecipientId(keys.publicKey));
    await expect(openPublicRepresentation(forged, pair, context)).rejects.toThrow();
  });

  it("bounds the presentation independently when YAML escapes expand a within-limit source", async () => {
    const source = `---\ntitle: "${"\\L".repeat(100_000)}"\n---\nBody`;
    expect(new TextEncoder().encode(source).length).toBeLessThanOrEqual(FILE_SOURCE_LIMIT);
    const { envelope, pair, context } = await sealed(source);
    expect(envelope.length).toBeLessThanOrEqual(MAX_PUBLIC_REPRESENTATION_BYTES);
    const presentation = await openPublicRepresentation(envelope, pair, context);
    expect(new TextEncoder().encode(presentation.title!).length).toBe(300_000);
    expect(presentation.markdown).toBe("Body");
  });

  it("fits a maximum-size Markdown source within the representation bound", async () => {
    const { envelope } = await sealed("a".repeat(FILE_SOURCE_LIMIT));
    expect(envelope.length).toBeLessThanOrEqual(MAX_PUBLIC_REPRESENTATION_BYTES);
  });
});

describe("Publication author declarations", () => {
  it("round-trips a pseudonym bound to its declaration, link and recipient key", async () => {
    const keys = await createPublicationKeyPair();
    const pair = await importPublicationKeyPair(keys.privateKey, keys.publicKey);
    const context = { publicationId, linkId, publicKey: keys.publicKey, declarationId, revision: 2 };
    const envelope = await sealAuthorDeclaration(context, "Member Quiet Pine");
    expect(inspectEnvelope(envelope).context).toEqual(authorDeclarationContext(context));
    expect(inspectEnvelope(envelope).context.purpose).toBe("publication-attribution");
    expect(await openAuthorDeclaration(envelope, pair, context)).toBe("Member Quiet Pine");
    await expect(openAuthorDeclaration(envelope, pair, { ...context, declarationId: publicationId })).rejects.toThrow();
    await expect(openAuthorDeclaration(envelope, pair, { ...context, revision: 1 })).rejects.toThrow();
  });

  it("rejects empty or oversized pseudonyms before encryption", async () => {
    const keys = await createPublicationKeyPair();
    const context = { publicationId, linkId, publicKey: keys.publicKey, declarationId, revision: 1 };
    await expect(sealAuthorDeclaration(context, "")).rejects.toThrow();
    await expect(sealAuthorDeclaration(context, "x".repeat(257))).rejects.toThrow();
  });
});
