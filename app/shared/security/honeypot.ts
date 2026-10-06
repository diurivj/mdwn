export const HONEYPOT_FIELD_NAME = "_mdwn_honeypot";

/**
 * Read only the boolean signal. Never return, persist, or log the submitted
 * honeypot value. Use only on registration and Public Comment forms.
 */
export function hasFilledHoneypot(formData: FormData): boolean {
  return formData.getAll(HONEYPOT_FIELD_NAME).some((value) => typeof value !== "string" || value.length > 0);
}

/** Same non-specific failure for a filled field; contains no submitted value. */
export function honeypotFailureResponse(): Response {
  return Response.json({ error: "request_failed" }, { status: 400, headers: { "Cache-Control": "no-store" } });
}
