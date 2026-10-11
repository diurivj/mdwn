/** Only source-controlled messages, command labels/statuses and resource identifiers
 * may be public. Never wrap raw output, SQL or another error's message in this type.
 */
export class PublicOperationalError extends Error {
  /** @param {string} message @param {ErrorOptions} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = "PublicOperationalError";
  }
}

/** Unclassified failures may contain exported values: keep their details off stdout.
 * @param {unknown} error
 */
export function publicErrorMessage(error) {
  return error instanceof PublicOperationalError ? error.message : "operation error (details withheld from console)";
}

/** For mode-0600 diagnostic artifacts only; never lifecycle messages.
 * @param {unknown} error @param {Set<unknown>} [seen] @returns {unknown}
 */
export function privateErrorDetails(error, seen = new Set()) {
  if (!(error instanceof Error)) return { message: String(error) };
  if (seen.has(error)) return { message: "[circular error reference]" };
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...("cause" in error ? { cause: privateErrorDetails(error.cause, seen) } : {}),
    ...(error instanceof AggregateError
      ? { errors: error.errors.map((entry) => privateErrorDetails(entry, seen)) }
      : {}),
  };
}
