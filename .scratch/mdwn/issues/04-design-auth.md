# Design authentication: passkeys, recovery, open signup

Type: grilling
Status: open
Blocked by: 01, 02

## Question

Given the privacy model (`01`) and the passkey research (`02`), lock the authentication design:

- Passkeys-only, or passkeys with a fallback? If fallback, what and how is it secured?
- The recovery flow in detail: what happens when a user loses every device? Who can recover, and what can they prove?
- Open signup: is email required as an identifier, and is it verified? What abuse controls (rate limits, proof of work, captcha) are acceptable given the no-tracking stance?
- Sessions: cookie strategy, lifetime, revocation.
- What identity does a user have if passkeys are device-bound? What anonymity do public readers get?

## Answer
