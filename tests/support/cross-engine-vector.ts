export const CROSS_ENGINE_ROUTE = {
  title: "mdwn — private markdown vault",
  heading: "A private markdown vault.",
} as const;

export const CROSS_ENGINE_VECTOR = {
  plaintext: "mdwn-cross-engine-webcrypto-v1",
  key: Array.from({ length: 32 }, (_, index) => index),
  iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  ciphertext: "2a66a175e886b074fe32baeedf8e1103e6fbf05192182d0548138aa86b58b4d36ac232e2f517cc3b69b687f70623",
} as const;

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
