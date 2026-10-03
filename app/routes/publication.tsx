import { data } from "react-router";
import { getEnv } from "~/context/env";
import { activePublicLink } from "~/publications/publications.server";
import { loadPublicPage, type PublicPage } from "~/publications/public-client";
import { MarkdownPreview } from "~/tree/MarkdownPreview";

import type { Route } from "./+types/publication";

const ROBOTS = "noindex, nofollow, noarchive";

export function meta({ loaderData }: Route.MetaArgs) {
  const page = loaderData as PublicPage | null | undefined;
  const title = page?.status === "ready" && page.title ? page.title : "Published File";
  return [{ title: `${title} — mdwn` }, { name: "robots", content: ROBOTS }, { name: "referrer", content: "no-referrer" }];
}

/** Non-sensitive existence check only. An unknown, rotated or sealed path gets
 * the same ciphertext-free 404; no ciphertext, File, Owner or key enters SSR. */
export async function loader({ params, context }: Route.LoaderArgs) {
  if (!await activePublicLink(getEnv(context), params.linkId)) throw data(null, { status: 404 });
  return null;
}

/** The read capability exists only in this browser's `location.hash`. */
export async function clientLoader({ params, request }: Route.ClientLoaderArgs): Promise<PublicPage> {
  const sameDocument = window.location.pathname === new URL(request.url).pathname;
  return loadPublicPage(params.linkId, sameDocument ? window.location.hash : "", request.signal);
}
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <main className="mx-auto max-w-3xl px-4 py-12" role="status">Opening published File…</main>;
}

const unavailable: Record<Exclude<PublicPage["status"], "ready">, string> = {
  "missing-key": "This public link is incomplete. Ask for the complete link, including the part after #.",
  "not-found": "This public link isn’t available.",
  unreadable: "This public link couldn’t be opened. Check that you copied the complete link.",
  unavailable: "This published File couldn’t be loaded. Try again.",
};

/** A read-only document: no path, breadcrumbs, Owner, timestamps or raw front matter. */
export default function PublicationRoute({ loaderData }: Route.ComponentProps) {
  const page = loaderData as PublicPage;
  if (page.status !== "ready") return <main className="mx-auto max-w-3xl px-4 py-12">
    <h1 className="text-2xl font-semibold">Published File</h1>
    <p role="alert" className="mt-3 text-stone-600">{unavailable[page.status]}</p>
  </main>;
  return <main className="mx-auto max-w-3xl px-4 py-10">
    <article aria-label="Published File">
      {page.title && <h1 className="mb-4 text-3xl font-semibold">{page.title}</h1>}
      {page.authors.length > 0 && <p className="mb-6 text-sm text-stone-600">By {page.authors.join(", ")}</p>}
      <div className="space-y-3 break-words"><MarkdownPreview source={page.markdown} /></div>
    </article>
    <footer className="mt-12 border-t border-stone-200 pt-4 text-xs text-stone-500">
      Read-only. This page is decrypted in your browser with the key after # in its link; mdwn never receives that key.
    </footer>
  </main>;
}
