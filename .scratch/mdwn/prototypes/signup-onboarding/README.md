# Signup onboarding — throwaway design study

**Question:** Which presentation makes saving two different recovery backups feel clear and worthwhile?

**Branch:** `prototype/signup-onboarding-ux` — keep out of `main`. Ticket 35 tracks the production rewrite. No design has been approved yet.

## See the mocks now

Open `index.html` in this directory directly. It is an offline gallery with desktop (1440 px) and mobile (390 px) screenshots of the separate save-phrase and confirmation screens for all three options. The prototype control bar is hidden in these snapshots so it does not obscure the designs.

| Variant | Direction | Structure |
| --- | --- | --- |
| A — Field notes | Warm, editorial, quiet | Persistent progress/context in the left margin; working area on the right |
| B — One thing at a time | Focused, restrained, sans-serif | Centered wizard, horizontal progress, full-width primary action |
| C — Recovery booklet | Tactile, book-like | A two-page spread: explanation on the left, recovery material on the right |

## Click through the flow

```sh
npm run prototype:signup
```

- A: http://127.0.0.1:5174/sign-up?variant=A&step=phrase
- B: http://127.0.0.1:5174/sign-up?variant=B&step=phrase
- C: http://127.0.0.1:5174/sign-up?variant=C&step=phrase

The bottom bar switches designs and screens. Left/right arrow keys also switch designs except while editing an input or using the screen selector. The selector can jump to introduction, phrase, confirmation, codes, simulated passkey creation, or completion. That control is for reviewing the mockup, not proposed product UI.

The phrase is removed from the DOM during confirmation. Back/review retains the same sample words and clears prior answers. Codes have a save acknowledgement; the passkey screen is explicitly simulated. No credential prompt, real signup API, crypto, storage, or analytics runs. Sample words/codes are not usable recovery material.

Everything runs on the existing `/sign-up` route behind `import.meta.env.DEV` and an explicit `variant` parameter. The normal signup renderer is unchanged without that parameter; production builds exclude the prototype module and controls. Do not promote this throwaway implementation directly to production.

The background preview-server command was blocked by a harness log-redirection guard; no server was started. Run the command above locally. The offline gallery needs no server.

## Capture and verification

Regenerate the gallery with:

```sh
npm run build
node scripts/prototype-signup-snapshots.mjs
```

Checked: typecheck, production build, client-bundle secret scan, and prototype-marker exclusion from client/server builds. Chromium rendered all 12 snapshots with no horizontal overflow and no phrase display on the confirmation screen. An isolated in-memory-router browser walkthrough exercised all three variants: mismatch, back/re-confirmation, code acknowledgement, simulated passkey cancellation/success, variant switching, and zero outgoing requests. This is prototype smoke verification, not production authentication or a complete accessibility/cross-browser test suite.

**Verdict:** pending maintainer feedback. Choose a direction, or identify parts to combine, before implementing ticket 35.
