import { useEffect, useRef } from "react";
import { data, useLocation, useRevalidator } from "react-router";
import { PublicComments } from "~/comments/public-comments";
import { getEnv } from "~/context/env";
import { activePublicLink } from "~/publications/publications.server";
import { loadPublicPage, type PublicPage } from "~/publications/public-client";
import { MarkdownPreview } from "~/tree/markdown-preview";
import type { ChromeHandle } from "~/ui/chrome";
import { LockIcon } from "~/ui/icons";
import { Logo } from "~/ui/logo";

import type { Route } from "./+types/publication";

const ROBOTS = "noindex, nofollow, noarchive";

/** A reader page: no site navigation, Account state or Session check. */
export const handle: ChromeHandle = { chrome: "reader" };

export function meta({ loaderData }: Route.MetaArgs) {
  const page = loaderData as PublicPage | null | undefined;
  const title = page?.status === "ready" && page.title ? page.title : "Published File";
  return [
    { title: `${title} — mdwn` },
    { name: "robots", content: ROBOTS },
    { name: "referrer", content: "no-referrer" },
  ];
}

/** Non-sensitive existence check only. An unknown, rotated or sealed path gets
 * the same ciphertext-free 404; no ciphertext, File, Owner or key enters SSR. */
export async function loader({ params, context }: Route.LoaderArgs) {
  if (!(await activePublicLink(getEnv(context), params.linkId))) throw data(null, { status: 404 });
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

// The fallback and every reader state share one shell, so the page keeps its
// frame while the document decrypts in the browser.
function ReaderShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[46rem] flex-col px-5 sm:px-8">
      <header className="flex items-center justify-between gap-4 border-b border-line py-6">
        <Logo className="text-[24px]" />
        <span className="eyebrow inline-flex items-center gap-1.5 border border-line bg-cream px-3 py-1.5 text-ink-soft">
          <LockIcon className="size-3.5 text-accent" />
          Read-only
        </span>
      </header>
      {children}
      <footer className="mt-auto border-t border-line py-6 text-xs leading-relaxed text-muted">
        Read-only. This page is decrypted in your browser with the key after # in its link; mdwn never receives that
        key.
      </footer>
    </div>
  );
}

export function HydrateFallback() {
  return (
    <ReaderShell>
      <main className="flex-1 pb-16 pt-6 sm:pt-10" aria-busy="true">
        <p role="status" className="text-sm text-muted">
          Opening published File…
        </p>
        <div aria-hidden="true" className="mt-8 space-y-4">
          <div className="skeleton h-12 w-3/4" />
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton mt-10 h-4" />
          <div className="skeleton h-4 w-11/12" />
          <div className="skeleton h-4 w-4/5" />
        </div>
      </main>
    </ReaderShell>
  );
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
  if (page.status !== "ready")
    return (
      <ReaderShell>
        <main className="flex-1 pb-16 pt-6 sm:pt-10">
          <p className="eyebrow text-accent">Public page</p>
          <h1 className="mt-3 font-display text-5xl font-light leading-tight tracking-tight">Published File</h1>
          <p role="alert" className="mt-4 max-w-xl leading-relaxed text-ink-soft">
            {unavailable[page.status]}
          </p>
        </main>
      </ReaderShell>
    );
  return (
    <ReaderShell>
      <main className="flex-1 pb-16 pt-6 sm:pt-10">
        <article aria-label="Published File" className="animate-fade">
          {page.title && (
            <h1 className="font-display text-[clamp(2.25rem,9vw,2.75rem)] font-light leading-[1.05] tracking-tight text-balance [overflow-wrap:anywhere] sm:text-6xl">
              {page.title}
            </h1>
          )}
          {page.authors.length > 0 && <p className="mt-4 text-sm text-muted">By {page.authors.join(", ")}</p>}
          <div
            className={`prose-markdown prose-reader ${page.title || page.authors.length ? "mt-8 border-t border-line pt-8 sm:mt-10 sm:pt-10" : ""}`}
          >
            <MarkdownPreview source={page.markdown} />
          </div>
        </article>
        {/* No Private/Public selector: the reader sees only explicitly public epochs. */}
        <PublicComments page={page} linkId={params.linkId} onRefresh={() => void revalidate()} />
      </main>
    </ReaderShell>
  );
}
