import { createRequestHandler } from "@react-router/cloudflare";
import { RouterContextProvider } from "react-router";
import { envContext } from "~/context/env";
import { startDeviceStateHeader } from "~/device/device-state.server";
import { purgeExpiredSignupProofs } from "~/device/proof.server";
import { purgeExpiredAbuseRecords } from "~/shared/security/abuse-control.server";
import { purgeExpiredPublicCommentReports } from "~/shared/security/public-participation.server";
import { purgeExpiredSecurityMaterial } from "~/retention/retention.server";
import { buildSecurityHeaders, generateCspNonce, responseCacheControl } from "~/shared/security/headers";
import { cspNonceContext } from "~/shared/security/nonce";
import { purgeExpiredGrantDependents } from "~/sharing/grant-expiry.server";

/**
 * The event object the fetch handler passes to the adapter. The adapter's
 * `createRequestHandler` is typed for a Cloudflare **Pages** `EventContext`;
 * on the **Workers** runtime we supply the subset of that contract the adapter
 * actually consumes (request, waitUntil, passThroughOnException, env) plus our
 * own `cspNonce` carry. The remaining Page-only fields (next, params, data,
 * functionPath) are never read by the adapter, so constructing honest values
 * for them would be fabrication — hence the single boundary assertion.
 */
type AdapterEvent = Parameters<typeof requestHandler>[0] & { cspNonce: string };

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
  async scheduled(_controller, env) {
    await purgeExpiredAbuseRecords(env.DB);
    await purgeExpiredPublicCommentReports(env.DB);
    await purgeExpiredSignupProofs(env);
    await purgeExpiredSecurityMaterial(env);
    await purgeExpiredGrantDependents(env);
  },

  async fetch(request, env, ctx) {
    const nonce = generateCspNonce();

    const event = {
      request,
      env,
      waitUntil: ctx.waitUntil.bind(ctx),
      passThroughOnException: ctx.passThroughOnException.bind(ctx),
      cspNonce: nonce,
    } as AdapterEvent;

    // A proof-guarded request learns the next device state from its own
    // response; the read runs beside the handler, not after it.
    const deviceState = startDeviceStateHeader(request, env);
    const response = await requestHandler(event);

    const headers = new Headers(response.headers);
    // Private-first app: never share dynamic responses across users, and never
    // let the edge transform (inject analytics into) a document.
    headers.set("Cache-Control", responseCacheControl(headers.get("Content-Type"), headers.get("Cache-Control")));
    const state = deviceState && (await deviceState);
    if (state) headers.set("X-Mdwn-Device-State", state);
    for (const [name, value] of Object.entries(buildSecurityHeaders({ nonce, dev: import.meta.env.DEV }))) {
      if (!headers.has(name)) headers.set(name, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
