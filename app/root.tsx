import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

/**
 * SSR rendering boundary: this Layout is the entire server-rendered
 * application shell. Loaders may return only non-sensitive data (see
 * docs/serving-and-security.md); private plaintext must never be rendered or
 * serialized here and later private routes must use client-only rendering.
 */

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="bg-stone-50 text-stone-900 antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong.";
  let details = "";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Page not found" : String(error.status);
    details = error.status === 404 ? "" : error.statusText;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold">{message}</h1>
      {details ? <p className="mt-2 text-stone-500">{details}</p> : null}
      {stack ? (
        <pre className="mt-4 w-full overflow-x-auto rounded-lg bg-stone-100 p-4 text-left text-xs">
          <code>{stack}</code>
        </pre>
      ) : null}
    </main>
  );
}
