import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { cspNonceContext } from "~/security/nonce";

/**
 * Server renderer. Only the application shell is rendered here; private
 * plaintext is never server-rendered (docs/serving-and-security.md). The CSP
 * nonce is read from the load context seeded by the Workers entry
 * (workers/app.ts) and applied both to the document stream and to React
 * Router's nonce-aware <Scripts>/<ScrollRestoration> elements via
 * <ServerRouter nonce>.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  const nonce = loadContext.get(cspNonceContext);

  const router = <ServerRouter nonce={nonce} context={routerContext} url={request.url} />;

  // WebKit keeps parser-blocking module scripts behind an open streaming
  // document. The browser-only crypto contract route is deliberately a
  // finite test document so its shared library can execute in every engine;
  // application routes retain the normal streaming renderer below.
  if (new URL(request.url).pathname === "/__test/enc-v1") {
    const finiteBody = await renderToReadableStream(router, { nonce });
    await finiteBody.allReady;
    const html = await new Response(finiteBody).text();
    responseHeaders.set("Content-Type", "text/html");
    return new Response(html, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const body = await renderToReadableStream(router, { nonce });

  // Stop rendering when the client disconnects (React streaming best
  // practice); otherwise the aborted render keeps consuming CPU.
  request.signal.addEventListener("abort", () => {
    void body.cancel();
  });

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}