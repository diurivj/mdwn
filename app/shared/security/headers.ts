/**
 * Security response headers and the strict Content Security Policy that the
 * Workers entry (workers/app.ts) applies to every response.
 *
 * This module is deliberately pure (no framework imports) so the policy can be
 * asserted by unit tests in a plain Node environment.
 *
 * Notes on the policy:
 * - script-src is nonce-based in production: every inline script (React Router
 *   hydration/stream plumbing) is emitted with `nonce="..."` matching the
 *   per-request nonce generated here. No 'unsafe-inline'/'unsafe-eval' in prod.
 * - style-src allows 'unsafe-inline' because React attributes and Tailwind's
 *   dev-mode <style> injection require it; the attack surface reduction from
 *   blocking external/injected styles exceeds the marginal risk.
 * - 'self' first-party resources only: no CDNs, no third-party scripts. mdwn
 *   pages never load third-party code (spec §3.6).
 * - X-Robots-Tag keeps every page, including Public pages, non-indexed and
 *   unarchived by default (spec §2.1, §6.5).
 */

/** Nonce charset: CSP-nonce is base64-ish; we generate base64url. */
const NONCE_RE = /^[A-Za-z0-9_-]{16,}$/;

/** Generate a fresh CSP nonce for one request. */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_");
}

/** Validate/normalize an incoming nonce; returns "" when unusable. */
export function normalizeCspNonce(nonce: string | undefined): string {
  return nonce && NONCE_RE.test(nonce) ? nonce : "";
}

function buildCsp(nonce: string, dev: boolean): string {
  const scriptSrc = dev
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : `'self' 'nonce-${nonce}'`;
  const connectSrc = dev
    ? "'self' ws: wss: http://localhost:* http://127.0.0.1:*"
    : "'self'";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export interface SecurityHeadersInput {
  /** CSP nonce for production responses; must be non-empty when !dev. */
  nonce: string;
  /** True when running under the local Vite dev server (relaxed CSP). */
  dev: boolean;
}

/**
 * Cache policy for dynamic app responses. mdwn is private-first: responses
 * are never shared across users, so every dynamic response is no-store unless
 * a route deliberately overrides it.
 */
export const DYNAMIC_CACHE_CONTROL = "no-store";

export function buildCspHeader(input: SecurityHeadersInput): string {
  return buildCsp(normalizeCspNonce(input.nonce), input.dev);
}

export function buildSecurityHeaders(input: SecurityHeadersInput): Record<string, string> {
  return {
    "Content-Security-Policy": buildCspHeader(input),
    // Always HTTPS on Cloudflare; HSTS covers any host that serves the app.
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // Camera is first-party for QR enrollment; other listed features stay disabled.
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), interest-cohort=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Anonymous public pages are non-indexed and unarchived by default (spec §2.1, §6.5).
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}
