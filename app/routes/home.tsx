import { LandingPage } from "~/landing/landing-page";

/**
 * The public landing page. Static by construction: no loader, no Session read
 * and no private data, so every visitor receives the same document.
 */
export function meta() {
  return [
    { title: "mdwn — private Markdown, end-to-end encrypted" },
    {
      name: "description",
      content:
        "In this agentic era, the only human thing we can defend is our privacy. mdwn is an end-to-end-encrypted home for Markdown: write and organize Files, open them on the devices you approve, and publish a page when you choose.",
    },
  ];
}

export default function Home() {
  return <LandingPage />;
}
