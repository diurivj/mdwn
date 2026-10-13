import { LandingPage } from "~/landing/landing-page";
import { SITE_ORIGIN } from "~/ui/share-preview";

const title = "mdwn — private Markdown, end-to-end encrypted";
const description =
  "In this agentic era, the only human thing we can defend is our privacy. mdwn is an end-to-end-encrypted home for Markdown: write and organize Files, open them on the devices you approve, and publish a page when you choose.";

/**
 * The public landing page. Static by construction: no loader, no Session read
 * and no private data, so every visitor receives the same document.
 */
export function meta() {
  return [
    { title },
    { name: "description", content: description },
    // The image and site name come from the root Layout's preview tags.
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: `${SITE_ORIGIN}/` },
  ];
}

export default function Home() {
  return <LandingPage />;
}
