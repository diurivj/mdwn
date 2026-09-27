import { deriveShareHandleLookupToken } from "../../app/sharing/share-handle";

function assertEqual(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
}

export const cases = [
  {
    name: "derives the frozen v1 token for the shortest handle",
    async run() {
      // Independently calculated using node:crypto SHA-256 over the literal tagged bytes + "a".
      assertEqual(await deriveShareHandleLookupToken("a"),
        "sh1:dEJNvN34AzDnzPFa8DdfgRsEoj8mFHIetJVLuu-U7Mw");
    },
  },
  {
    name: "folds ASCII capitals only and keeps hyphen, underscore and device-name spellings distinct",
    async run() {
      // Literal reference vectors computed independently with node:crypto; these are
      // not derived from the application helper or from another test runtime.
      const alice = "sh1:sYgK0eW6DfzVCUcNDlphPgu7BCqXpp9jXpWA5cu2zC0";
      assertEqual(await deriveShareHandleLookupToken("ALICE"), alice);
      assertEqual(await deriveShareHandleLookupToken("Alice"), alice);
      assertEqual(await deriveShareHandleLookupToken("alice"), alice);
      assertEqual(await deriveShareHandleLookupToken("a-b"),
        "sh1:fxXfqzjRu7wThiP75ReTfPtGMQuY2hZZviCMSTyXVZY");
      assertEqual(await deriveShareHandleLookupToken("a_b"),
        "sh1:ZEUH5rT9z6heDKfeZ786EQ5qJmDlg_v8QGT3zFHGzKI");
      assertEqual(await deriveShareHandleLookupToken("CON"),
        "sh1:NV784cOyCN9St1rvVGuK0th4YmANXLTKmidv78FgRH0");
    },
  },
  {
    name: "accepts the 64-character boundary with a canonical 32-byte base64url digest",
    async run() {
      const token = await deriveShareHandleLookupToken("z".repeat(64));
      assertEqual(token, "sh1:_9I0AxruYnhlm2XPoLfCuyhISo4YSId2VHHaZBm4FFg");
      if (token.length !== 47 || !/^sh1:[A-Za-z0-9_-]{43}$/.test(token)) {
        throw new Error(`Noncanonical share handle token: ${token}`);
      }
      const digest = token.slice(4);
      const decoded = atob(digest.replace(/-/g, "+").replace(/_/g, "/") + "=");
      if (decoded.length !== 32 ||
          btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== digest) {
        throw new Error("Share handle digest is not canonical 32-byte base64url");
      }
    },
  },
  {
    name: "rejects nonstrings and every out-of-profile spelling without trimming or Unicode folding",
    async run() {
      const invalid: unknown[] = [
        undefined, null, 1, false, new String("alice"), [], {},
        "", "a".repeat(65), "@a", "@@a", "a@b", " a", "a ", "a b",
        "a\t", "a\n", "a\r", "a\0b", "a.b", "a/b", "a\\b",
        "á", "a\u0301", "Ａ", "🙂", "\uD800", "\uDC00", "a\u200Bb",
      ];
      for (const input of invalid) {
        try {
          await Reflect.apply(deriveShareHandleLookupToken, undefined, [input]);
        } catch {
          continue;
        }
        throw new Error(`Expected invalid share handle to be rejected: ${String(input)}`);
      }
    },
  },
] satisfies Array<{ name: string; run: () => Promise<void> }>;
