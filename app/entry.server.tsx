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

  const body = await renderToReadableStream(
    <ServerRouter nonce={nonce} context={routerContext} url={request.url} />,
    { nonce },
  );

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