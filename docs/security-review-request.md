# Independent security review request

This is the engagement document for an independent security review of mdwn.
Send it to the candidate reviewer together with the pinned commit and
repository access. The reviewer-facing evidence map is
[`docs/acceptance.md`](acceptance.md); the normative behavior is
[`docs/buildable-spec.md`](buildable-spec.md); terminology is
[`CONTEXT.md`](../CONTEXT.md).

No end-to-end-security claim is made until this review is complete and its
findings are triaged.

## Engagement at a glance

| | |
| --- | --- |
| Target | mdwn — private Markdown vault, React Router v8 on Cloudflare Workers + D1, browser-only encryption |
| Artifact | source code at a pinned commit (below), read-only access or an archive |
| Type | source-code security review with local test execution; **not** a live production pentest |
| Suggested effort | 3–5 focused reviewer-days for the scope below; adjust in the quote |
| Deliverable | written report (format below), optional retest after fixes |
| Out of scope | Cloudflare account security, provider backup/Time Travel guarantees, legal/privacy notices, UI visual polish |

## Pin and reproduce

```sh
git clone <repository>            # access provided by the maintainer
git checkout <PINNED_COMMIT>      # the maintainer records the exact SHA here
npm ci                            # Node 24
npm run verify                    # typecheck, 599 unit/Worker tests, build,
                                  # migration smoke, secrets, all 3 browser engines
```

Optional, only with a **disposable** Cloudflare account (never the project's
preview or production):

```sh
npx wrangler login
node scripts/import-proof.mjs     # provisions and deletes its own Worker + D1
```

Rules: use synthetic data only; never apply migrations or run tooling against
the project's real preview/production D1; do not publish findings or the
repository contents; report privately to the maintainer.

## System in one paragraph

Private Markdown, file/directory names, ordering, comments, and displayed
pseudonyms are encrypted and decrypted only in the browser. The Worker and D1
store opaque IDs, ciphertext envelopes, authorization relationships, epochs,
sizes, and timestamps. Passkeys authenticate accounts but never derive or
unlock content. The browser client is part of the trusted computing base, so
"a compromised browser, malicious extension, XSS, malicious dependency, or a
service serving altered JavaScript" is an explicit boundary — not a finding
unless the code fails to disclose or contain it. The review's job is to attack
the boundary itself and everything inside it.

## What to attack

Each item names the claim and where to start. A "pass" means the reviewer
could not break the claim, or found the failure mode already honestly
disclosed.

### 1. Plaintext boundary

- Can any request make the Worker or D1 persist a plaintext name, Markdown
  body, front matter, comment body, pseudonym, recovery phrase, or capability?
  Try malformed/oversized payloads, error paths, retries, import records, and
  header/query smuggling. Check every table, not just the obvious one.
- Can any response (SSR HTML, loaders, JSON resources, error bodies,
  `/healthz`, public routes) return private or Collaborators-only ciphertext,
  envelopes, or plaintext to a caller without current authorization?
- Are there logs, traces, analytics, or persisted operational records at all?
  If so, what can reach them? (Spec: no blanket request logging; Security
  events are allowlisted metadata only.)

### 2. Envelope cryptography (`mdwn/enc-v1`)

- Cross-purpose, cross-object, cross-epoch (including newer-than-current),
  cross-recipient, cross-Publication, downgrade-suite, malformed framing,
  truncation, tag-swap, and length-extension style attempts.
- Nonce/key-domain reuse across tabs, devices, retries, and interrupted jobs;
  writer restart behavior; failure paths that might resume a used sequence.
- HPKE usage (`DHKEM(P-256, HKDF-SHA-256)`, `HKDF-SHA-256`, `AES-256-GCM`) and
  canonical authenticated-context encoding — anything that makes two different
  contexts collide, or lets a context be omitted/confused.

### 3. Keys, grants, rotation, revocation

- Can a revoked account/device keep reading or writing through cached
  ciphertext, a stale epoch, a prepared save, a pending rotation, or an
  overlapping Grant?
- Does revocation deny server access before rotation, and do new writes stay
  blocked until the rotation is safe? Can a rotation be made to promote a
  replacement key beneath a revoked parent, or to skip a descendant?
- Direct File Grants: can a recipient learn a parent path, siblings, or a
  neighboring File? Can a read-only Grant edit Markdown or mutate structure?
- Import into a shared Directory: can a Collaborator create content under its
  own ownership, gain new authority, or leave a partial tree?

### 4. Authentication, devices, recovery

- Signup: replay proof of work, replay or mismatch the registration challenge,
  substitute candidate keys, alter the transcript/capsule digest, swap the
  binding signature, race concurrent commits. Can any failure leave a partial
  account, a capsule-less account, a root-envelope-less account, or a
  `crypto_jobs` row?
- Sessions: cookie forgery/replay, idle/absolute expiry, passkey-linked
  revocation, restricted recovery sessions, global revocation.
- Device proofs: replay a mutation proof, reuse a read proof, present a stale
  epoch, bind a session to a revoked/tombstoned device, bypass a proof on any
  private route (including export, enrollment, removal, comments, imports).
- Routine enrollment: QR/pending mismatch, substituted candidate key, altered
  approval or envelope digest, expired/replayed state, missing fresh Passkey
  assertion, inactive approver, missing candidate private key.
- Recovery: recovery-code replay/race, code-set replacement, stale capsule
  generation, substituted keys, replayed enrollment nonce, missing fresh
  assertion, and whether old devices/sessions really lose authority
  atomically. Does Grant-derived content stay unavailable until an authorized
  holder provisions it — and never after revocation?
- Passkey management: remove the last recovery path, resurrect a removed
  passkey's sessions, bypass the fresh-assertion requirement.

### 5. Authorization, publications, comments

- Enumerate IDs across owners: private Files/Directories, Shares/Grants,
  Publications, Comments, imports. Same non-revealing failure for
  inaccessible and deleted objects?
- Permission matrix (spec §6.2): Owner, Directory read/write, Directory
  read-only, direct File read/write, direct File read-only, anonymous Public
  reader. Comment author/Owner mutation rules; read-only comment
  participation; structural denial for direct-File Grants.
- Publications: unknown, rotated, and sealed paths indistinguishable and
  ciphertext-free; only current Public representation and allowed public
  epochs; audience transitions never leak Collaborators-only history;
  signed-in-but-unauthorized callers get nothing; link rotation preserves the
  thread; unpublish destroys it and a later Publication starts fresh;
  interrupted teardown stays sealed and Owner-resumable.
- Pseudonym update: all-old or all-new committed attribution, never mixed;
  resumable by an enrolled device; cannot be used to bypass work blocking.
- Public link fragments: confirm the capability never appears in a request
  URL, referrer, error, log, SSR payload, or persisted row.

### 6. Abuse controls and operational data

- Rate-limit scope confusion (global vs. network vs. account vs. session vs.
  publication), rolling-window boundary off-by-ones, generic failures that
  reveal account/recovery existence, `Retry-After` correctness.
- Raw IP or other prohibited fields persisting anywhere; Network-bucket HMAC
  key/epoch handling; honeypot handling (generic failure, no persistence).
- Scheduled retention: expired challenges, sessions, proofs, enrollments,
  imports, counters, reports, Security events; idempotence and bounded
  backlogs. Can an expired artifact retain authority until it is physically
  deleted?
- Public-participation suspension cannot block export, hard deletion,
  unpublish, or session revocation.

### 7. Delivery and client

- CSP and security headers: any script/connect/style bypass, nonce handling,
  third-party origins, `unsafe-inline`/`unsafe-eval`; no third-party scripts on
  crypto or public-reader pages.
- Markdown rendering: raw HTML, unsafe link schemes, front-matter handling,
  sanitization bypasses.
- Client bundle: secrets, private keys, capabilities, or recovery material in
  `build/client`; `.server` module leakage.
- Same-origin enforcement on every mutation; cookie flags
  (`Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` prefix).
- D1 schema: `CHECK`/`FOREIGN KEY`/trigger enforcement of the documented
  bounds, and whether any reachable code path can violate an invariant the
  schema does not also enforce.

### 8. Concurrency and atomicity

- Same-revision two-client mutations: exactly one commit, `409` loser, no
  visible partial state.
- Import: commit-marker visibility, exact duplicate retries, mismatched
  retries, missing sequences, malformed descriptors, cancellation, expiry,
  disconnect, stale authority, failed commit — none may create a marker or
  visible data; a staged Replace must keep the old representation current
  until the marker.
- Hard deletion: File and ≤500-node Directory delete every dependent record
  atomically; >500 nodes change nothing; no generic cascade stands in for
  authorization.

## Already-disclosed limits (validate, don't rediscover)

The reviewer should confirm these are honestly stated, not treat them as new
findings:

- Browser client in the TCB; downloaded plaintext cannot be recalled; a
  malicious service serving altered JavaScript is outside the honest-client
  boundary.
- Provider-managed backups/Time Travel are outside application-level deletion
  guarantees; generalized production-sized export restore is open (ticket 38).
- Capacity is bounded by application limits; under the intended Workers Paid
  baseline, usage beyond included allowances is metered and nothing caps the
  invoice ([operations policy](operations.md#workers-paid-operating-policy)).
- No account deletion, account-wide export, notifications, attachments,
  search, or jurisdiction-specific notices in the MVP.
- Public-comment reports are category-only signals, not moderation content.

## Deliverables

A written report containing:

1. **Executive summary** — what was reviewed, what was found, and whether the
   end-to-end-security claim is supportable as stated.
2. **Findings** — each with: severity (Critical/High/Medium/Low/Info),
   affected `file:line`, the violated spec/invariant, a minimal reproduction,
   impact, and a concrete fix or mitigation. Separate confirmed exploits from
   theoretical weaknesses and from best-practice suggestions.
3. **Coverage statement** — which areas above were examined, which were not,
   and what evidence (tests/commands) was run.
4. **Retest note** — whether a follow-up pass is recommended after fixes.
5. **Attestation** — the reviewer's independence statement and the exact
   commit reviewed.

## Engagement record (maintainer fills in)

| | |
| --- | --- |
| Reviewer / firm | |
| Pinned commit | |
| Start / end date | |
| Report location | |
| Findings triaged on | |
| Retest needed | |
| End-to-end-security claim allowed | |
