/**
 * Plain-text copies of recovery material for people who keep it offline as a
 * file or a printout. The text is made in this browser and saved by it; it is
 * never sent anywhere. The phrase and the codes stay separate files, because
 * together with the Account they are everything needed to take it over.
 */
export function recoveryPhraseText(phrase: string, created = new Date()): string {
  const words = phrase.split(" ");
  return [
    "mdwn recovery phrase",
    "",
    "These 24 words, with a passkey for your Account, restore access to your",
    "encrypted Files on a new browser. mdwn never receives them and cannot",
    "recover them for you.",
    "",
    "Keep this file offline (printed, or on a drive you control) and separate",
    "from your recovery codes. Delete other copies once it is stored.",
    "",
    ...words.map((word, index) => `${String(index + 1).padStart(2, " ")}. ${word}`),
    "",
    `Saved ${created.toISOString().slice(0, 10)}. A newer phrase replaces this one.`,
    "",
  ].join("\n");
}

export function recoveryCodesText(codes: readonly string[], identifier?: string, created = new Date()): string {
  return [
    "mdwn recovery codes",
    "",
    "Each code works once and lets you add a new passkey if you lose them all.",
    "They restore sign-in, not your Files. Keep them apart from your recovery phrase.",
    "",
    ...(identifier ? [`Recovery identifier (not secret): ${identifier}`, ""] : []),
    ...codes.map((code, index) => `${String(index + 1).padStart(2, " ")}. ${code}`),
    "",
    `Saved ${created.toISOString().slice(0, 10)}. Replacing your codes invalidates this set.`,
    "",
  ].join("\n");
}
