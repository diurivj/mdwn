import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import "@fontsource-variable/inter-tight/wght.css";
import "@fontsource-variable/inter-tight/wght-italic.css";
import "@fontsource/courier-prime/latin-400.css";
import "@fontsource/courier-prime/latin-700.css";
import interLatin from "@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2?url";
import courierLatin from "@fontsource/courier-prime/files/courier-prime-latin-400-normal.woff2?url";

import type { Route } from "./+types/root";
import "./app.css";
import { type Chrome, useChrome } from "./ui/chrome";
import { ArrowRightIcon } from "./ui/icons";
import { usePendingPage } from "./ui/pending-page";
import { SiteFooter } from "./ui/site-footer";
import { SiteHeader } from "./ui/site-header";
import { buttonClass } from "./ui/styles";

/**
 * SSR rendering boundary: this Layout is the entire server-rendered
 * application shell. Loaders may return only non-sensitive data (see
 * docs/serving-and-security.md); private plaintext must never be rendered or
 * serialized here and later private routes must use client-only rendering.
 */

export const links: Route.LinksFunction = () => [
  // The two faces every page shows above the fold, requested before the stylesheet asks.
  { rel: "preload", href: interLatin, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
  { rel: "preload", href: courierLatin, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#eeece6" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-dvh bg-paper font-sans text-ink antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Header and footer around a page, chosen by the route's `handle.chrome` unless a pending destination's applies. */
function SiteChrome({
  children,
  chrome,
  footer = true,
}: {
  children: React.ReactNode;
  chrome?: Chrome;
  footer?: boolean;
}) {
  const routeChrome = useChrome();
  chrome ??= routeChrome;
  if (chrome === "reader") return children;
  return (
    <>
      <a
        href="#content"
        className="sr-only z-50 bg-ink px-4 py-2 text-sm text-paper focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
      >
        Skip to content
      </a>
      <SiteHeader chrome={chrome} />
      <div id="content" tabIndex={-1} className="outline-none">
        {children}
      </div>
      {footer && chrome !== "workspace" && <SiteFooter />}
    </>
  );
}

export default function App() {
  const pending = usePendingPage(useChrome());
  return (
    <SiteChrome chrome={pending?.chrome}>
      {pending?.page}
      {/* The page being left stays mounted, hidden, until its destination renders. */}
      <div className={pending ? "hidden" : "contents"}>
        <Outlet />
      </div>
    </SiteChrome>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong.";
  let details = "";
  let stack: string | undefined;
  const notFound = isRouteErrorResponse(error) && error.status === 404;

  if (isRouteErrorResponse(error)) {
    message = notFound ? "Page not found" : String(error.status);
    details = notFound ? "" : error.statusText;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <SiteChrome footer={false}>
      <main className="container-page flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center py-24 text-center">
        <p className="eyebrow text-accent">{notFound ? "Error 404" : "Unexpected error"}</p>
        <h1 className="mt-4 max-w-xl font-display text-5xl font-light leading-tight tracking-tight text-balance sm:text-6xl">
          {message}
        </h1>
        <p className="mt-4 max-w-md text-ink-soft">
          {details ||
            (notFound
              ? "This page isn’t here. Your Files are exactly where you left them."
              : "Nothing private was shown. Try again in a moment.")}
        </p>
        {/* A full document load deliberately resets whatever state failed. */}
        <a href="/" className={`${buttonClass("primary", "lg")} mt-8`}>
          Back to mdwn <ArrowRightIcon />
        </a>
        {stack ? (
          <pre className="mt-10 w-full max-w-3xl overflow-x-auto border border-line bg-cream p-4 text-left text-xs">
            <code>{stack}</code>
          </pre>
        ) : null}
      </main>
    </SiteChrome>
  );
}
