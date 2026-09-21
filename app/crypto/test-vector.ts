import type { EnvelopeContext } from "./envelope";

export const ENC_V1_VECTOR_CONTEXT: EnvelopeContext = {
  vaultId: "vault-01",
  objectId: "object-01",
  keyId: "key-01",
  purpose: "file-content",
  epoch: 7,
  recipientId: "device-01",
  publicationId: "publication-01",
};

export const ENC_V1_VECTOR_KEY = Uint8Array.from(
  Array.from({ length: 32 }, (_, index) => index),
);

export const ENC_V1_VECTOR_NONCE = Uint8Array.from(
  Array.from({ length: 12 }, (_, index) => 0x10 + index),
);

export const ENC_V1_VECTOR_PLAINTEXT = new TextEncoder().encode(
  "mdwn enc-v1 vector",
);

// Independent literal used by Node, Worker, and browser vector tests.
export const ENC_V1_VECTOR_AAD_HEX =
  "6d64776e2f656e632d76312f616164010103000c66696c652d636f6e74656e7400087661756c742d303100096f626a6563742d303100066b65792d3031000000000000000700096465766963652d3031000e7075626c69636174696f6e2d3031";

export const ENC_V1_VECTOR_CIPHERTEXT_HEX =
  "109aef7869ac54d0e703393d791c0a27b82225a072786a14407a94680db269d1a4b0";

export const HPKE_VECTOR_PRIVATE_KEY = Uint8Array.from([
  ...Array.from({ length: 31 }, () => 0),
  1,
]);

export const HPKE_VECTOR_PUBLIC_KEY = Uint8Array.from(
  "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5".match(
    /../g,
  ) ?? [],
  (pair) => Number.parseInt(pair, 16),
);

export const HPKE_VECTOR_EPHEMERAL_KEY_MATERIAL = Uint8Array.from(
  Array.from({ length: 32 }, (_, index) => 0xa0 + index),
);

export const HPKE_VECTOR_ENVELOPE_HEX =
  "6d64776e2f656e632d7631010203000c66696c652d636f6e74656e7400087661756c742d303100096f626a6563742d303100066b65792d3031000000000000000700096465766963652d3031000e7075626c69636174696f6e2d3031043ecd14c425a55bda0ea6cdf16031bd5a04cc337706cfdeb38b2afa37967be5dc4373a4bd215f7b473252305ed2a9b86a8cb439f186765df4838459b1ca04c4b800000022f9d5b8e65d98b7bace54a48e26cf2cddcff51029e93714a225395168178d29a3d10c";
