import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { MarkdownPreview } from "../../app/tree/MarkdownPreview";

it("renders GFM while dropping raw HTML and unsafe links from the private preview", () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, {
    source: "# Private heading\n\n| Col | Value |\n| --- | --- |\n| a | b |\n\n<script>window.leak()</script>\n\n[click](javascript:alert(1))",
  }));
  expect(html).toContain("<h1>Private heading</h1>");
  expect(html).toContain("<table>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("href=\"javascript:");
});
