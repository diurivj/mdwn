# 35: Signup onboarding UX and recovery-backup confirmation

**What to build:** An intentional, accessible signup flow that helps a person understand, save, and verify their recovery material before creating their Account, without weakening ticket 08's cryptographic or interrupted-signup guarantees.

**Blocked by:** 08 (complete; signup and first-Encryption-device bootstrap).

**Status:** ready-for-agent

**Design decision:** The maintainer approved Option A's flow and the optional backup-passkey treatment recorded under Comments. Use the throwaway prototype as a reference, not production-ready code; approval does not mark this implementation ticket complete.

**Priority:** Address before copying signup's interaction patterns into recovery and device-enrollment screens. This does not block ticket 09's authorization work and must remain separate from the resource-route documentation PR.

## Problem

`app/routes/sign-up.tsx` currently renders all 24 recovery words alongside the three verification inputs. A person can answer directly from the page without consulting a saved copy. The screen sequence also uses generic account-creation labels during local preparation and gives little explanation of why two distinct recovery artifacts must be saved. Functional signup completion is not a finished onboarding experience; ticket 33's acceptance/accessibility checks do not specify this redesign.

## Flow and presentation

- [ ] Agree on a compact sequence: introduction → save recovery phrase → confirm saved phrase → save recovery codes → create passkey → completion. Distinguish local preparation from registration in loading copy. Give every additional click a clear purpose rather than adding redundant acknowledgements.
- [ ] Explain the distinction before presenting the material: recovery codes restore Account authentication when passkeys are unavailable; the recovery phrase restores access to the person's own encrypted Files alongside a recently Passkey-verified normal Session. Neither artifact substitutes for the other. Use plain-language UI copy, with “Files,” never “Vault.”
- [ ] Present the numbered phrase in a readable responsive layout with offline-backup guidance. An explicit “I saved my phrase” action advances to confirmation; it does not clear the recovery gate or start registration.
- [ ] During confirmation, require three randomly selected word positions from the same prepared phrase. Remove the full phrase display from the rendered DOM, not merely visually hide it; do not expose expected answers through hidden text, attributes, input defaults, or answer hints. Explain that the person should consult their saved copy, not memorize the words. This is a backup check, not proof of durable storage or an authentication boundary.
- [ ] Provide an explicit “Go back and review” action from confirmation. It returns to the same phrase without generating new keys or recovery material. Returning to confirmation clears entered answers and mismatch feedback and requires verification again. Incorrect or incomplete answers cannot advance.
- [ ] Show the ten distinct recovery codes after successful phrase verification, explain their one-use purpose and separate safe storage, and require an explicit saved-codes acknowledgement before registration. The final action clearly communicates that it starts passkey creation and finishes signup. Do not redisplay recovery material after completion.
- [ ] Approve and implement a consistent onboarding layout: deliberate typography, spacing, progress indication, one clear primary action per step, and differentiated secondary navigation. Cover narrow and wide screens, long recovery codes, visible focus, keyboard order, labelled fields, focus movement on step changes, and announced loading/errors. Do not introduce an app-wide design-system rewrite.
- [ ] Make success and failure useful and accurate. Completion confirms that the Account exists and signup is finished with one passkey. A backup-passkey suggestion is clearly optional and secondary, or deferred to Account security—not another required setup step. Once the Files workspace exists, its primary action is “Go to Files”; until then, do not link to an unbuilt workspace. Failure preserves generic retry/sign-in guidance without assuming whether a commit succeeded. Prevent duplicate submission and do not turn a back action into another registration attempt.

## Invariants and scope

- [ ] Preserve the existing order in `app/signup/bootstrap.ts`: prepare locally → verify the phrase and acknowledge saved codes → clear the client-local confirmation gate → request the one-use challenge and perform registration. No registration request or passkey ceremony begins before both recovery steps are complete. If gate storage is unwritable, fail closed rather than proceeding.
- [ ] Preserve atomic Account/device/capsule creation, persisted non-extractable device keys, ordinary Device proofs, bind-on-sign-in after a lost commit response, proof of work, honeypot, rate limits, and generic server errors. Do not change cryptography, endpoint contracts, database schema, or move content recovery into authentication.
- [ ] Keep plaintext recovery material browser-local and transient. Do not add SSR/hydration payloads, URLs, requests, logs, telemetry, or browser-storage persistence containing the phrase, entered recovery words, recovery codes, or plaintext keys. Do not persist a signup wizard to resume after reload. Any copy/download affordance needs an explicit design decision; do not add automatic clipboard or download behavior.
- [ ] Keep the client-local content-creation gate and its later File/Directory/Import integration contract intact. Update signup documentation to describe the approved UX and pre-registration recovery confirmation accurately: `docs/buildable-spec.md` §5.2 currently lists presentation after the commit, while ticket 08 and the shipped implementation deliberately confirm recovery first for lost-response safety. Clarify that wording rather than reversing the shipped ordering.

## Verification

- [ ] Update `e2e/signup-recovery.ts` to capture the phrase in the save step, advance, assert that the phrase display/expected answers are absent, and fill the selected positions from the saved test copy. Do not keep a helper that reads answers beside the verification fields.
- [ ] Cover correct and incorrect confirmation, incomplete input, back/review/re-confirmation, unchanged prepared material during review, saved-codes acknowledgement, no early registration requests, duplicate clicks, and keyboard/focus transitions.
- [ ] Retain cross-engine coverage for reload/interruption, local-storage failure, passkey cancellation, and lost commit response/sign-in. Add missing UI-level cases without weakening the existing bootstrap/privacy assertions; no failure path may silently skip recovery confirmation or claim an Account was definitely not created after an ambiguous response.
- [ ] Run typecheck, Node/Workers tests, production build and client-bundle secret check, and the full Chromium/Firefox/WebKit browser suite. Manually walk through the approved desktop/mobile layout and keyboard/screen-reader flow. Complete Standards, Spec, and the separate RR8 post-review gate before merge.

## Starting points

- `app/routes/sign-up.tsx` — current screen state and markup.
- `app/signup/bootstrap.ts` — local preparation, confirmation gate, and registration boundary.
- `e2e/signup-recovery.ts`, `e2e/signup.spec.ts`, `e2e/signup-integrity.spec.ts` — recovery presentation and signup regressions.
- Ticket 08, `docs/buildable-spec.md` §5.2, and `CONTEXT.md` — signup guarantees and recovery terminology.

## Comments

- Maintainer requested a dedicated follow-up after noticing that verification words remain visible and that signup's interactions/layout feel generic. The agreed direction is separate save/confirm steps, clearer recovery explanations and progress, deliberate responsive design, and preserved signup guarantees. The visual/interaction proposal still needs approval before production implementation.
- Design study: `prototype/signup-onboarding-ux` is the throwaway primary-source branch, not a branch to merge into `main`. It contains three clickable variants on the existing dev-only `/sign-up?variant=A|B|C` surface: **A — Field notes**, **B — One thing at a time**, and **C — Recovery booklet**. Run `npm run prototype:signup` and open `http://127.0.0.1:5174/sign-up?variant=A&step=phrase`. The offline screenshot gallery is `.scratch/mdwn/prototypes/signup-onboarding/index.html` on that branch, with desktop/mobile save and confirmation screens for all three directions. All recovery material and passkey interactions are fake; the production build excludes the prototype. See that directory's README for the verified scope and preview instructions. **Verdict pending:** no visual direction or production implementation has been approved.
- Maintainer decision after trying the mockups: **Option A's flow is approved.** The second-passkey suggestion is acceptable as an optional backup, not a condition of completing signup. Completion should emphasize that the Account is ready; a future “Go to Files” action takes precedence over the optional backup-passkey suggestion. The prototype's prominent second-passkey button predates this clarification and should not dictate the production hierarchy. Production implementation remains pending.
