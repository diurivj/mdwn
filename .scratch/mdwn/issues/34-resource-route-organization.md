# 34: Organize React Router resource-only route modules

**What to build:** Put resource-only route modules in the folders specified by `AGENTS.md` without changing any public URL, request contract, security check, or response. This is file organization, not a change to input sanitization or endpoint behavior.

**Blocked by:** 08 (Signup: first-Encryption-device bootstrap; includes the signup and device resource routes in PR #11).

**Status:** ready-for-agent

- [ ] Move the `/api/*` resource-only modules (`auth`, `signup`, `device-state`, and `private-bootstrap`) into `app/routes/api/`. Leave their authentication, crypto, database, and other business logic in the existing feature modules.
- [ ] Move non-API resource-only modules (`healthz` and `robots.txt`) into `app/routes/resources/`. Leave page modules such as Home, Sign in, Sign up, and Account security at the top level of `app/routes/`.
- [ ] Update the explicit module paths in `app/routes.ts` and any affected generated route-type imports or references. The URLs, supported methods, status codes, headers, JSON/text bodies, same-origin checks, cookie handling, and Worker bindings must remain unchanged.
- [ ] Verify that resource routes remain resource-only (no SSR page or private hydration payload), that `.server` imports stay out of the client bundle, and that route handlers remain thin adapters rather than duplicating feature logic.
- [ ] Run typecheck, a production build, route-boundary tests through `SELF.fetch`, and the full browser suite against the existing URLs. Confirm no unrelated migration or database change is needed.

## Comments

- This follow-up is separate from signup PR #11; wait for ticket 08 to land before moving its route modules. The folder name does not create a URL because this project maps routes explicitly in `app/routes.ts`.
