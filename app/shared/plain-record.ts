/**
 * Whether `value` is a plain object record — not an array, class instance or
 * object with an inherited prototype — so a strict message validator can
 * check its own fields exactly.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
