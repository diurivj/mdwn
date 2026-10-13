import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ticket 68: the icons and link-preview banner in public/. Workers Static
 * Assets serves these before the Worker runs, so none of them gets the
 * Worker's CSP or other headers; the SVG must therefore stay a static image.
 * `tests/worker/site-head.test.ts` pins the tags that point at them.
 */
const PUBLIC = join(process.cwd(), "public");

function pngSize(file: string) {
  const bytes = readFileSync(join(PUBLIC, file));
  expect(bytes.subarray(1, 4).toString("latin1"), file).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Width and height from a baseline or progressive JPEG's start-of-frame marker. */
function jpegSize(file: string) {
  const bytes = readFileSync(join(PUBLIC, file));
  expect(bytes.readUInt16BE(0), file).toBe(0xffd8);
  for (let offset = 2; offset < bytes.length; ) {
    const marker = bytes.readUInt16BE(offset);
    if (marker === 0xffc0 || marker === 0xffc2)
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error(`${file}: no frame header`);
}

describe("site icons and preview banner", () => {
  it("lists only icons that exist at their declared sizes in the manifest", () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC, "site.webmanifest"), "utf8")) as {
      name: string;
      start_url: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest).toMatchObject({ name: "mdwn", start_url: "/" });
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(icon.type).toBe("image/png");
      expect(pngSize(icon.src.replace(/^\//, ""))).toEqual({ width, height });
    }
    expect(pngSize("apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
    expect(existsSync(join(PUBLIC, "favicon.ico"))).toBe(true);
  });

  it("keeps the SVG icon a plain drawing with no script, link or external reference", () => {
    const svg = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");
    const elements = [...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((match) => match[1]);
    expect(new Set(elements)).toEqual(new Set(["svg", "title", "rect", "path"]));
    expect(svg).not.toMatch(/\son\w+\s*=|href|<!|<\?|url\(|javascript:/i);
  });

  it("serves the banner as the 1200×630 JPEG the preview tags declare, small enough for every preview", () => {
    expect(jpegSize("og-image.jpg")).toEqual({ width: 1200, height: 630 });
    // WhatsApp drops preview images above roughly 300 KB.
    expect(statSync(join(PUBLIC, "og-image.jpg")).size).toBeLessThan(300 * 1024);
  });
});
