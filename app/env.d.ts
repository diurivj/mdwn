/**
 * Ambient augmentation for bindings that are NOT visible to `wrangler types`
 * from wrangler.jsonc: values wired through Cloudflare Secrets.
 *
 * `wrangler types` derives bindings from wrangler.jsonc and local `.dev.vars`,
 * but production Secrets are not in wrangler.jsonc. Augment both the global
 * Worker `Env` and `Cloudflare.Env` used by Cloudflare's test API. DB and
 * APP_ENV are covered by generated config and must NOT be redeclared.
 */
declare global {
  interface MdwnSecretBindings {
    /** Gate for the /healthz probe. Cloudflare Secret per environment. */
    HEALTHZ_TOKEN?: string;
    /** HMAC key for signed opaque Account Session cookies. */
    SESSION_COOKIE_SECRET?: string;
    /** Rotatable HMAC key for purpose/time-epoch-scoped abuse-control buckets. */
    ABUSE_HMAC_SECRET?: string;
  }

  interface Env extends MdwnSecretBindings {}

  namespace Cloudflare {
    interface Env extends MdwnSecretBindings {}
  }
}

export {}
