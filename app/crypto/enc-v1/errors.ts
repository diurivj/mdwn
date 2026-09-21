export type EnvelopeErrorCode =
  | "malformed"
  | "unsupported-version"
  | "unsupported-suite"
  | "context-mismatch"
  | "stale-epoch"
  | "unexpected-epoch"
  | "replayed-manifest"
  | "authentication-failed"
  | "nonce-exhausted";

/** Contains no plaintext, keys, identifiers, or underlying crypto exceptions. */
export class EnvelopeError extends Error {
  constructor(readonly code: EnvelopeErrorCode) {
    super(`mdwn/enc-v1: ${code}`);
    this.name = "EnvelopeError";
  }
}
