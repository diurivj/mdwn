/**
 * What a link preview shows for any mdwn page: the site's own name and
 * banner, never anything from an Account or a File. Social crawlers need
 * absolute URLs, so these name the production origin on every deployment.
 * The image and icons are static files in `public/`.
 */
export const SITE_ORIGIN = "https://mdwn.me";

export const SHARE_IMAGE = {
  url: `${SITE_ORIGIN}/og-image.jpg`,
  type: "image/jpeg",
  width: 1200,
  height: 630,
  alt: "mdwn: Made with AI. Kept for you. A private home for your Markdown files.",
} as const;

/** The preview tags every page carries, rendered once in the document head. */
export const sharePreviewTags = [
  { property: "og:site_name", content: "mdwn" },
  { property: "og:type", content: "website" },
  { property: "og:image", content: SHARE_IMAGE.url },
  { property: "og:image:type", content: SHARE_IMAGE.type },
  { property: "og:image:width", content: String(SHARE_IMAGE.width) },
  { property: "og:image:height", content: String(SHARE_IMAGE.height) },
  { property: "og:image:alt", content: SHARE_IMAGE.alt },
  { name: "twitter:card", content: "summary_large_image" },
] as const;
