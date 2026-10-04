import { loadLinkPublicComments, publicCommentsWire, type PublicLinkComments } from "~/comments/public-client";
import { decodeTreeBytes } from "~/tree/wire";
import { decodePublicationPublicKey, importPublicationKeyPair, isPublicationIdentifier, parsePublicationFragment } from "./capability";
import {
  MAX_AUTHOR_DECLARATION_BYTES, MAX_PUBLIC_REPRESENTATION_BYTES, MAX_PUBLICATION_AUTHORS,
  openAuthorDeclaration, openPublicRepresentation,
} from "./content";

export type PublicPage =
  | { status: "ready"; title: string | null; markdown: string; authors: string[];
    comments: PublicLinkComments | null }
  | { status: "missing-key" | "not-found" | "unreadable" | "unavailable" };

type PublicResponse = {
  publicationId: string; linkId: string; publicKey: string;
  representation: { revision: number; ciphertext: string };
  authors: { declarationId: string; revision: number; ciphertext: string }[];
  comments?: unknown;
};

const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/**
 * Browser-only Public reader. The fragment scalar is parsed locally and never
 * enters a request, URL, log, error, or rendered message; the request carries
 * only the opaque path ID, with no cookies or referrer.
 */
export async function loadPublicPage(linkId: string, hash: string, signal?: AbortSignal): Promise<PublicPage> {
  const privateKey = parsePublicationFragment(hash);
  if (!privateKey) return { status: "missing-key" };
  if (!isPublicationIdentifier(linkId)) return { status: "not-found" };
  let response: Response;
  try {
    response = await fetch(`/api/public/publications/${linkId}`, { method: "GET", credentials: "omit",
      cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "unavailable" };
  }
  if (response.status === 404) return { status: "not-found" };
  if (!response.ok) return { status: "unavailable" };
  try {
    const body = await response.json() as PublicResponse;
    if (body.linkId !== linkId || !isPublicationIdentifier(body.publicationId) || !revision(body.representation?.revision) ||
        !Array.isArray(body.authors) || body.authors.length > MAX_PUBLICATION_AUTHORS) return { status: "unreadable" };
    const publicKey = decodePublicationPublicKey(body.publicKey);
    const keyPair = await importPublicationKeyPair(privateKey, publicKey);
    const binding = { publicationId: body.publicationId, linkId, publicKey };
    const presentation = await openPublicRepresentation(
      decodeTreeBytes(body.representation.ciphertext, MAX_PUBLIC_REPRESENTATION_BYTES), keyPair,
      { ...binding, revision: body.representation.revision });
    const authors: string[] = [];
    for (const author of body.authors) {
      if (!isPublicationIdentifier(author?.declarationId) || !revision(author.revision)) continue;
      try {
        authors.push(await openAuthorDeclaration(decodeTreeBytes(author.ciphertext, MAX_AUTHOR_DECLARATION_BYTES), keyPair,
          { ...binding, declarationId: author.declarationId, revision: author.revision }));
      } catch { /* An unreadable attribution never blocks the document. */ }
    }
    // Public Comment epochs are supplementary: a malformed page never hides the
    // document, and an unreadable epoch only hides its own ciphertext.
    const commentWire = publicCommentsWire(body.comments);
    const comments = commentWire ? await loadLinkPublicComments({ publicationId: body.publicationId, linkId,
      privateKey, publicKey, comments: commentWire }).catch(() => null) : null;
    return { status: "ready", title: presentation.title, markdown: presentation.markdown, authors, comments };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "unreadable" };
  }
}
