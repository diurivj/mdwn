import { useEffect, useRef } from "react";
import { data, useLocation, useRevalidator } from "react-router";
import { PublicComments } from "~/comments/PublicComments";
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
  const pathname = new URL(request.url).pathname;
  while (true) {
    request.signal.throwIfAborted();
    const hash = window.location.pathname === pathname ? window.location.hash : "";
    const page = await loadPublicPage(params.linkId, hash, request.signal);
    request.signal.throwIfAborted();
    // A fragment can change during initial hydration, before the page mounts.
    // Never install a result decrypted for a superseded browser capability.
    if (window.location.pathname !== pathname || window.location.hash === hash) return page;
  }
}
clientLoader.hydrate = true as const;

// The fallback shares this shell with the page so it stays in the main route
// chunk: hydrating with `clientLoader.hydrate` alongside a server loader needs
// HydrateFallback in the hydrated route module, not only in the SSR build.
const shell = "mx-auto max-w-3xl px-4";

export function HydrateFallback() {
  return <main className={`${shell} py-12`} role="status">Opening published File…</main>;
}

const unavailable: Record<Exclude<PublicPage["status"], "ready">, string> = {
  "missing-key": "This public link is incomplete. Ask for the complete link, including the part after #.",
  "not-found": "This public link isn’t available.",
  unreadable: "This public link couldn’t be opened. Check that you copied the complete link.",
  unavailable: "This published File couldn’t be loaded. Try again.",
};

/** A read-only document: no path, breadcrumbs, Owner, timestamps or raw front matter. */
export default function PublicationRoute({ loaderData, params }: Route.ComponentProps) {
  const page = loaderData as PublicPage;
  const location = useLocation();
  const { revalidate, state } = useRevalidator();
  const locationKey = location.pathname + location.hash;
  const previousLocation = useRef<string | null>(null);
  const changed = previousLocation.current !== null && previousLocation.current !== locationKey;
  const incompleteNavigation = previousLocation.current === null && page.status === "missing-key" && !!location.hash;
  useEffect(() => {
    const changed = previousLocation.current !== null && previousLocation.current !== locationKey;
    const incomplete = previousLocation.current === null && page.status === "missing-key" && !!location.hash;
    previousLocation.current = locationKey;
    // RR skips loaders for hash-only navigation. Revalidate through its native
    // cancellation/race handling; the fragment stays browser-local, not in a URL
    // passed to fetch, a submission or server loader data.
    if (changed || incomplete) void revalidate();
  }, [locationKey, location.hash, page.status, revalidate]);
  if (changed || incompleteNavigation || state === "loading") return <HydrateFallback />;
  if (page.status !== "ready") return <main className={`${shell} py-12`}>
    <h1 className="text-2xl font-semibold">Published File</h1>
    <p role="alert" className="mt-3 text-stone-600">{unavailable[page.status]}</p>
  </main>;
  return <main className={`${shell} py-10`}>
    <article aria-label="Published File">
      {page.title && <h1 className="mb-4 text-3xl font-semibold">{page.title}</h1>}
      {page.authors.length > 0 && <p className="mb-6 text-sm text-stone-600">By {page.authors.join(", ")}</p>}
      <div className="space-y-3 break-words"><MarkdownPreview source={page.markdown} /></div>
    </article>
    {/* No Private/Public selector: the reader sees only explicitly public epochs. */}
    <PublicComments page={page} linkId={params.linkId} onRefresh={() => void revalidate()} />
    <footer className="mt-12 border-t border-stone-200 pt-4 text-xs text-stone-500">
      Read-only. This page is decrypted in your browser with the key after # in its link; mdwn never receives that key.
    </footer>
  </main>;
}
