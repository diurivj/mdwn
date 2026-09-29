# 23: Public Comment threads and Comment audience epochs

**What to build:** A Publication has its own Comment thread whose audience the Owner controls: anonymous readers with the complete link can read (and, when signed in and private-capable, post to) public epochs, while Collaborators-only epochs stay available to current File-read Accounts and invisible to everyone else.

**Blocked by:** 21 (Private Comment threads), 22 (Publish a File).

**Status:** ready-for-agent

- [ ] One Public Comment thread exists per logical Publication, built from ordered, independently keyed Comment audience epochs (`comment_thread_epochs`: immutable `public | collaborators_only` audience, key epoch, order, lifecycle state). New Publications default to `public`.
- [ ] Each audience change starts a new epoch, and every epoch is explicitly marked public or collaborators-only; Public readers receive only epochs explicitly marked public.
- [ ] A public epoch is wrapped to the Publication capability and directly enveloped to eligible Owner/Collaborator devices; a Collaborators-only epoch has only direct device envelopes and is never wrapped to the Publication capability.
- [ ] In `public`, anyone with the complete link can read public epochs, and a signed-in link visitor posts through a private-capable, device-bound Session plus the locally held fragment capability; an unprovisioned Session cannot post.
- [ ] `public -> collaborators_only` stops anonymous thread delivery immediately and creates a fresh device-enveloped epoch; `collaborators_only -> public` creates a fresh public epoch wrapped to the Publication capability and eligible devices; prior Collaborators-only epochs are never returned by the anonymous route.
- [ ] In `collaborators_only`, only the Owner and Accounts with effective File-read access read or post through the authenticated File route; an unauthenticated Public reader receives **Sign in to see or add comments if you have access to this file** and no thread ciphertext; signing in without a qualifying Grant never reveals Collaborators-only ciphertext.
- [ ] An eligible Owner or Collaborator device may read and post through its direct epoch envelope and the authenticated File route without receiving or retaining the URL fragment; eligible authenticated Accounts retain authorized history across epochs.
- [ ] Losing the last File-read path immediately removes authenticated Public and Private Comment authorization, and the current Collaborators-only epoch rotates before accepting new Comments for remaining devices.
- [ ] Every read and create checks active thread and Publication state, current audience authorization, and epoch; edit/delete additionally checks author identity with Owner hard-delete as the only author exception; Public Comment participation counters are consumed atomically with accepted create, edit, and report operations.
- [ ] Private Comments are never copied or exposed when publishing; a Public reader sees only eligible public epochs under the rendered document, with no Private/Public selector.
- [ ] Tests prove audience transitions never disclose Collaborators-only history publicly, an unauthorized signed-in Account receives no data, and the Private thread is absent from every Public response.
- [ ] (Moved from 07.) A Public Comment create, edit or report that is rate-limited or over quota gets the generic `429` with `Retry-After` (`rateLimitResponse`). The response never confirms whether an Account exists, and the Comment draft held by the browser survives the denial.
- [ ] (Moved from 07.) The Public Comment form has one static, genuinely hidden, non-autofillable honeypot field (`HoneypotField`). A non-empty value creates no Comment and gets only a generic failure. The value is never logged or persisted, and at most a `honeypot-filled` Security event is recorded.

## Comments

- 2026-09-21: Dependency note from ticket 03: one Public audience epoch needs two envelopes with different suites — the Publication-capability wrapper (symmetric) and each device envelope (HPKE). The ticket 03 purpose table carries one `public-comment-audience-epoch`, so this ticket must split it into two distinct purposes (for example `public-comment-epoch-link` and `public-comment-epoch-device`) and keep them distinguishable in the authenticated context. A device envelope must not be trusted on a successful open alone, because HPKE base mode names no sender.
