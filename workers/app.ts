import { createRequestHandler } from "@react-router/cloudflare";
import { RouterContextProvider } from "react-router";
import { envContext } from "~/context/env";
import { buildSecurityHeaders, DYNAMIC_CACHE_CONTROL, generateCspNonce } from "~/security/headers";
import { cspNonceContext } from "~/security/nonce";

/**
 * React Router v8 Framework Mode entry point on the Cloudflare Workers
 * runtime, using the @react-router/cloudflare adapter.
 *
 * Security model: one CSP nonce per request, generated here before dispatch
 * and carried on the event object into getLoadContext, which seeds it into
 * the per-request load context. entry.server.tsx consumes that value to stamp
 * the document's inline scripts, and the fetch handler uses the same
 * (closure-scoped) value for the CSP header. No module-level mutable state,
 * so the value can never be confused across requests. Headers are applied at
 * the Workerd boundary so matched routes, unmatched 404s, .data requests,
 * resource routes, and error pages all receive the identical strict policy.
 */
const requestHandler = createRequestHandler<Env>({
  build: () => import("virtual:react-router/server-build"),
  mode: import.meta.env.MODE,
  getLoadContext({ context }) {
    // cspNonce is carried on the event (not part of the PagesFunction type).
    const nonce = (context.cloudflare as { cspNonce?: string }).cspNonce;
    if (!nonce) throw new Error("cspNonce was not carried on the worker event");

    const provider = new RouterContextProvider();
    provider.set(envContext, context.cloudflare.env);
    provider.set(cspNonceContext, nonce);
    return provider;
  },
});

export default {
  async fetch(request, env, ctx) {
    const nonce = generateCspNonce();

    // The adapter follows a PagesFunction-style event shape; on Workers we
    // supply the subset of the event it consumes (request, waitUntil,
    // passThroughOnException, env) plus our own cspNonce carry. The cast
    // adapts the Workers fetch handler to the PagesFunction contract;
    // remaining Page-only fields (next, params, data, …) are never read by
    // the adapter.
    const event = {
      request,
      env,
      waitUntil: ctx.waitUntil.bind(ctx),
      passThroughOnException: ctx.passThroughOnException.bind(ctx),
      cspNonce: nonce,
    } as Parameters<typeof requestHandler>[0] & { cspNonce: string };

    const response = await requestHandler(event);

    const headers = new Headers(response.headers);
    if (!headers.has("Cache-Control")) {
      // Private-first app: never share dynamic responses across users.
      headers.set("Cache-Control", DYNAMIC_CACHE_CONTROL);
    }
    for (const [name, value] of Object.entries(
      buildSecurityHeaders({ nonce, dev: import.meta.env.DEV }),
    )) {
      if (!headers.has(name)) headers.set(name, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;