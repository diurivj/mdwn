import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Ticket 68: every document names the site icons and carries the same link
 * preview (the static banner and site name); the landing page adds its own
 * title and description. Nothing in either comes from an Account or a File.
 */
async function head(path: string) {
  const html = await (await SELF.fetch(`https://mdwn.test${path}`)).text();
  return html.slice(0, html.indexOf("</head>"));
}

describe("the document head", () => {
  it("links the icons and the manifest from public/", async () => {
    const document = await head("/");
    expect(document).toMatch(/<link [^>]*rel="icon" href="\/favicon\.ico" sizes="16x16 32x32 48x48"\/>/);
    expect(document).toMatch(/<link [^>]*rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any"\/>/);
    expect(document).toMatch(/<link [^>]*rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180"\/>/);
    expect(document).toMatch(/<link [^>]*rel="manifest" href="\/site\.webmanifest"\/>/);
  });

  it("gives the landing page a full link preview with an absolute banner URL", async () => {
    const document = await head("/");
    for (const tag of [
      '<meta property="og:site_name" content="mdwn"/>',
      '<meta property="og:type" content="website"/>',
      '<meta property="og:image" content="https://mdwn.me/og-image.jpg"/>',
      '<meta property="og:image:type" content="image/jpeg"/>',
      '<meta property="og:image:width" content="1200"/>',
      '<meta property="og:image:height" content="630"/>',
      '<meta name="twitter:card" content="summary_large_image"/>',
      '<meta property="og:title" content="mdwn — private Markdown, end-to-end encrypted"/>',
      '<meta property="og:url" content="https://mdwn.me/"/>',
    ]) {
      expect(document).toContain(tag);
    }
    expect(document).toMatch(/<meta property="og:description" content="In this agentic era/);
    expect(document.match(/property="og:image"/g)).toHaveLength(1);
  });

  it("keeps the generic preview on a page whose route sets its own meta", async () => {
    const document = await head("/sign-in");
    expect(document).toContain('<meta property="og:image" content="https://mdwn.me/og-image.jpg"/>');
    expect(document).not.toContain('property="og:title"');
  });
});
