import { createElement } from "react";
import { HONEYPOT_FIELD_NAME } from "./honeypot";

/**
 * Static auxiliary bot signal. Render once on registration or Public Comment
 * forms only; never add it to sign-in or recovery forms.
 */
export function HoneypotField() {
  return createElement("input", {
    type: "text",
    name: HONEYPOT_FIELD_NAME,
    hidden: true,
    "aria-hidden": true,
    tabIndex: -1,
    autoComplete: "off",
    inputMode: "none",
    style: { display: "none" },
  });
}
