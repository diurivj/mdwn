# 69: Finish signup quickly and show what happens after recovery is confirmed

**What to build:** After the person confirms they saved their recovery phrase and codes, signup should reach the passkey prompt quickly and say what it is doing. Today the page falls back to the first signup form with a disabled **Creating your account…** button while the browser solves the proof of work, which takes seconds and sometimes much longer. Make the proof of work fast, show a real final step with its progress, and give each failure guidance that says whether the saved phrase and codes still apply.

**Type:** feature

**Status:** ready-for-agent

**Blocked by:** none.

**Related:** [08: signup and first-device bootstrap](08-signup-first-device-bootstrap.md); [36: browser-suite signup reduction](36-browser-suite-signup-and-server-checks.md) (measured the solver); wayfinder [16](../wayfinder/16-lock-abuse-and-rate-limit-policy.md) and [27](../wayfinder/27-define-first-encryption-device-bootstrap.md); [ADR-0005](../../../docs/adr/0005-privacy-preserving-abuse-controls.md); `docs/buildable-spec.md` §5.2.

## Problems found (before this ticket)

- **The page goes back to step 0.** Confirming recovery set the `working` stage, which renders the first signup form (pseudonym, three-item list) with a disabled **Creating your account…** button. Nothing says what is happening or that a passkey prompt is coming.
- **The proof of work is slow and erratic.** The solver awaited one WebCrypto `digest` per candidate, about 55–100 thousand hashes a second in Chromium, Firefox and WebKit on an Apple M5 Pro. The expected 2^18 candidates took 2.7–4.8 s on average; single measured signups took up to 20.4 s, and phones are slower still. Everything else between the click and the prompt took about 0.1 s.
- **Any failure discards the saved recovery material.** A dismissed passkey prompt, a dropped request or a rate-limited start showed the first form again; **Create account** then made a new Account ID with a new phrase and codes, after the person had just written down the old ones.
- **The failure text was the same for every case**, including "sign in if your passkey was saved" when no passkey could exist, and nothing explained a rate limit or when to retry.

## Scope

- **Solver** (`app/shared/signup/protocol.ts`): a synchronous SHA-256 specialized to the single padded block of `challenge || nonce`, with rounds 0–8 computed once per challenge and nonce high word, run in ~12 ms main-thread slices that yield through a `MessageChannel` task. The found nonce is checked with WebCrypto before it is returned. The protocol, the 18-bit difficulty, the random start and the search order are unchanged.
- **Commit** (`app/signup/bootstrap.ts`): `signupCommit` replaces `commitSignup`. It reports the step (signup check, passkey, save) and classifies every failure: `request`, `limited` (429 at the start), `passkey`, `device`, `full` (429 at the commit) and `unconfirmed`. It keeps only the transcript base and material, never the phrase or codes.
  - Before a passkey exists, a retry uses the same local material: a fresh rate-limited start, or, after a dismissed prompt, the same registration while its WebAuthn challenge is fresh (3 minutes of the service's 5).
  - Once a passkey exists, the material is never reused: if the Account was committed, another passkey for the same Account ID would replace the registered one in the person's passkey manager.
- **Step 3 UI** (`app/signup/passkey-step.tsx`, `app/routes/sign-up.tsx`): **Step 3 of 3 · Create your passkey** with progress rows (recovery saved, signup check, passkey, account), a status line per step, and a notice per failure with the right action (**Try again**, **Create passkey**, **Sign in** / **Start over**, or none). Focus moves to that action. Each step starts scrolled to its heading.
- **Library preload:** when the phrase step appears, a dynamic import of `app/tree/library-preload.ts` (the Files page and its loader) fetches the library's code, so opening the library after the commit waits mostly for its data. It sends no signup request. React Router's `PrefetchPageLinks` was measured and rejected: its `loadRouteModule` reloads the page when a route module fails to load, which would discard a signup in progress; a failed import here only loses the head start.
- The registration and WebAuthn challenge lifetime is one shared constant (`SIGNUP_CHALLENGE_MS`), so the browser's reuse window cannot outlive the Worker's challenge.
- Docs: `docs/buildable-spec.md` §5.2 (retry rule and bootstrap UI states) and `docs/testing.md`.

Out of scope: fetching the challenge or solving it before recovery is confirmed (the documented "no signup request before confirmation" guarantee stays), the proof-of-work difficulty or protocol, rate-limit policy, and the Files page load after signup.

## Acceptance criteria

- [x] Confirming recovery shows step 3 with its progress, never the first form; the passkey prompt follows without a seconds-long wait.
- [x] The solver returns the same first qualifying nonce as before for a given start, across the nonce's word boundary and the 64-bit wrap, agrees with node:crypto SHA-256 on random inputs, and stops at the next slice once aborted.
- [x] A failed or rate-limited start and a dismissed prompt retry with the same Account ID, so the saved phrase and codes stay valid; a dismissed prompt reopens without another start.
- [x] Lost device keys, a refused commit and an unknown commit outcome never retry the same material; an unknown outcome offers sign-in and a new start.
- [x] Worker, unit and Chromium/Firefox/WebKit coverage; existing signup, integrity and golden-path checks still pass.
- [ ] Merge gate: clean-head `npm run verify` evidence is recorded with the PR, and every current-head `CI` job passes before merge.

## Comments

- 2026-10-13: Published from the maintainer's `/goal`: make signup faster, and after the words and recovery codes are confirmed, explain what is happening and why it takes long instead of showing the same page with the button disabled; improve the timings.
- 2026-10-13: Implemented on `issue/69-faster-signup`. Measurements, Apple M5 Pro, headless Playwright 1.63:
  - **Solver, hashes per second** (WebCrypto per candidate → new): Chromium 60 k → 5.6 M, Firefox 99 k → 4.4 M, WebKit 55 k → 4.3 M. Expected solve: 4.4 s / 2.7 s / 4.8 s → 47 / 59 / 60 ms; sliced solves averaged 35–77 ms (p90 83–182 ms). With Chromium's CPU throttled 8×, the old solver still took ~5.3 s (its cost is WebCrypto round trips, not CPU) and the new one ~0.4–0.5 s (p90 ~0.9 s).
  - **Confirm click → Library visible**, real signup against the built Worker, three runs per engine: before 0.18–20.5 s (the proof of work alone 0.06–20.3 s); after 0.14–0.27 s.
  - **Slow network** (150 ms latency, 1.6 Mbit/s, CPU 4×, Chromium, 5 s spent on the codes step): commit response → Library visible went from ~1.9 s to ~0.73 s with the library preload (~0.55 s with `PrefetchPageLinks`); confirm click → Library visible 1.35–1.48 s.
  - Kept: no signup request before recovery is confirmed. Fetching and solving the challenge during the codes step would save one more round trip and the solve, but would contact the signup endpoints (and their rate-limit counters) for people who leave at that step.
