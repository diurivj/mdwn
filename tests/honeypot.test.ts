import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HONEYPOT_FIELD_NAME, hasFilledHoneypot, honeypotFailureResponse } from "../app/security/honeypot";
import { HoneypotField } from "../app/security/HoneypotField";

describe("registration and Public Comment honeypot", () => {
  it("renders one static, hidden, non-autofillable, non-focusable field", () => {
    const markup = renderToStaticMarkup(createElement(HoneypotField));

    expect(markup).toContain(`name="${HONEYPOT_FIELD_NAME}"`);
    expect(markup).toContain('type="text"');
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toMatch(/autocomplete="off"/i);
    expect(markup).toMatch(/inputmode="none"/i);
    expect(markup).toContain('display:none');
    expect(markup.match(/<input/g)).toHaveLength(1);
  });

  it("detects only a non-empty value without exposing it in the generic failure", async () => {
    const form = new FormData();
    form.set(HONEYPOT_FIELD_NAME, "");
    expect(hasFilledHoneypot(form)).toBe(false);
    form.set(HONEYPOT_FIELD_NAME, "private bot payload");
    expect(hasFilledHoneypot(form)).toBe(true);

    const duplicateField = new FormData();
    duplicateField.set(HONEYPOT_FIELD_NAME, "");
    duplicateField.append(HONEYPOT_FIELD_NAME, "private bot payload");
    expect(hasFilledHoneypot(duplicateField)).toBe(true);

    const response = honeypotFailureResponse();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request_failed" });
  });
});
