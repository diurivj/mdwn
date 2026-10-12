/**
 * A Public pseudonym is chosen by its person and shown beside their Comments
 * and on Publications that credit them. It is checked here, in the browser,
 * because the service only ever stores it encrypted.
 */
export const PSEUDONYM_MIN_CHARACTERS = 2;
export const PSEUDONYM_MAX_CHARACTERS = 32;

export type PseudonymProblem = "empty" | "short" | "long" | "characters";

export const PSEUDONYM_PROBLEMS: Record<PseudonymProblem, string> = {
  empty: "Enter a pseudonym.",
  short: `Use at least ${PSEUDONYM_MIN_CHARACTERS} characters.`,
  long: `Use at most ${PSEUDONYM_MAX_CHARACTERS} characters.`,
  characters: "Remove invisible or control characters.",
};

/** The stored form: NFC, trimmed, with each run of whitespace as one space. */
export function normalizePseudonym(input: string): string {
  return input.normalize("NFC").trim().replace(/\s+/gu, " ");
}

// After normalization, control, format, private-use and unassigned characters
// could still make two labels look identical or reorder their text. The two
// zero-width joiners stay: emoji sequences and several scripts need them.
const HIDDEN = /[\p{Cc}\p{Co}\p{Cn}\p{Cs}]|(?![\u200c\u200d])\p{Cf}/u;

/** Why `input` cannot be a pseudonym, or null when its normalized form can. */
export function pseudonymProblem(input: string): PseudonymProblem | null {
  const pseudonym = normalizePseudonym(input);
  if (!pseudonym) return "empty";
  const length = Array.from(pseudonym).length;
  if (length < PSEUDONYM_MIN_CHARACTERS) return "short";
  if (length > PSEUDONYM_MAX_CHARACTERS) return "long";
  return HIDDEN.test(pseudonym) ? "characters" : null;
}

const ADJECTIVES = [
  "Amber",
  "Bright",
  "Calm",
  "Cedar",
  "Clever",
  "Cobalt",
  "Coral",
  "Distant",
  "Early",
  "Ember",
  "Gentle",
  "Golden",
  "Hidden",
  "Hollow",
  "Ivory",
  "Lunar",
  "Misty",
  "Northern",
  "Olive",
  "Patient",
  "Quiet",
  "Rapid",
  "Restless",
  "Salt",
  "Silent",
  "Silver",
  "Slow",
  "Steady",
  "Still",
  "Swift",
  "Velvet",
  "Wandering",
  "Wild",
  "Winter",
  "Woven",
  "Young",
];

const NOUNS = [
  "Badger",
  "Brook",
  "Comet",
  "Fern",
  "Finch",
  "Fox",
  "Hare",
  "Harbor",
  "Heron",
  "Ibis",
  "Kestrel",
  "Lantern",
  "Lark",
  "Lynx",
  "Maple",
  "Meadow",
  "Moth",
  "Newt",
  "Osprey",
  "Otter",
  "Owl",
  "Pebble",
  "Pine",
  "Plover",
  "Quill",
  "Raven",
  "River",
  "Robin",
  "Sparrow",
  "Tern",
  "Thistle",
  "Vole",
  "Willow",
  "Wren",
  "Yarrow",
];

function pick<T>(items: readonly T[], random: number): T {
  return items[random % items.length]!;
}

/** A friendly suggestion, such as "Quiet Heron 27"; people may keep it or write their own. */
export function suggestPseudonym(): string {
  const [adjective, noun, number] = crypto.getRandomValues(new Uint32Array(3));
  return `${pick(ADJECTIVES, adjective!)} ${pick(NOUNS, noun!)} ${10 + (number! % 90)}`;
}
