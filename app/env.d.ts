/**
 * Ambient augmentation for bindings that are NOT visible to `wrangler types`
 * from wrangler.jsonc: values wired through Cloudflare Secrets.
 *
 * `wrangler types` derives Env from wrangler.jsonc plus a local `.dev.vars`
 * if present — so locally HEALTHZ_TOKEN appears in the generated Env only
 * because `.dev.vars` exists. CI has no `.dev.vars`, so this declaration is
 * what keeps typecheck green there. Applied to `env.HEALTHZ_TOKEN`; DB and
 * APP_ENV are covered by the generated config and must NOT be redeclared.
 */
declare global {
  interface Env {
    /** Gate for the /healthz probe. Cloudflare Secret per environment. */
    HEALTHZ_TOKEN?: string;
    /** HMAC key for signed opaque Account Session cookies. */
    SESSION_COOKIE_SECRET?: string;
    /** Rotatable HMAC key for purpose/time-epoch-scoped abuse-control buckets. */
    ABUSE_HMAC_SECRET?: string;
  }
}

export {}
