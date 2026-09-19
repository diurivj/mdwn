import { describe, expect, it } from "vitest";

import {
  buildCspHeader,
  buildSecurityHeaders,
  generateCspNonce,
  normalizeCspNonce,
} from "../app/security/headers";

const NONCE = "testNonceValue123456";

describe("CSP (production)", () => {
  const csp = buildCspHeader({ nonce: NONCE, dev: false });

  it("is a single block with all directives present", () => {
    for (const directive of [
      "default-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "upgrade-insecure-requests",
      "img-src 'self' data:",
      "font-src 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
  });

  it("uses a nonce and never unsafe-inline/unsafe-eval in script-src", () => {
    const scriptSrc = csp.match(/script-src ([^;]+)/)?.[1];
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("allows first-party resources only (no remote hosts)", () => {
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toMatch(/cdn|fonts\./);
  });

  it("binds connect-src and style-src sanely", () => {
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
  });
});

describe("CSP (development)", () => {
  it("relaxes script/connect for the local Vite dev server only", () => {
    const csp = buildCspHeader({ nonce: NONCE, dev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toMatch(/connect-src [^;]*ws:/);
  });
});

describe("security headers on every response", () => {
  it("includes the full hardening set", () => {
    const headers = buildSecurityHeaders({ nonce: NONCE, dev: false });
    expect(headers["Content-Security-Policy"]).toBeTruthy();
    expect(headers["Strict-Transport-Security"]).toContain("max-age=63072000");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(headers["X-Robots-Tag"]).toBe("noindex, nofollow");
  });
});

describe("nonce generation", () => {
  it("produces unpredictable, reusable nonces", () => {
    const a = generateCspNonce();
    const b = generateCspNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it("drops unusable nonce values instead of emitting them", () => {
    expect(normalizeCspNonce("")).toBe("");
    expect(normalizeCspNonce("short")).toBe("");
    expect(normalizeCspNonce("has spaces and quotes \"")).toBe("");
    expect(normalizeCspNonce("okBase64urlValue_12345")).toBe("okBase64urlValue_12345");
  });
});