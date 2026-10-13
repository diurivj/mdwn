import { type ComponentProps, type MouseEvent, useEffect, useRef, useState } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * Browser-only rendering. Never parse raw HTML; sanitize plugin output as defense in depth.
 * Typography comes from the surrounding `.prose-markdown` container (app/app.css).
 */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
      {source}
    </Markdown>
  );
}

// rehype-sanitize prefixes every id it keeps. GFM footnote hrefs already carry
// the prefix once, so `#user-content-fn-1` points at `user-content-user-content-fn-1`.
const SANITIZED_ID_PREFIX = "user-content-";

function decodeFragment(fragment: string) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Moves to a link's in-page target without touching the URL fragment: on a
 * Public page the fragment is the read capability, so following `#…` in place
 * or in a new tab would replace the key. Focus follows for keyboard and
 * screen-reader users; a target that doesn't exist does nothing.
 */
function followInPageLink(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const id = SANITIZED_ID_PREFIX + decodeFragment(event.currentTarget.getAttribute("href")!.slice(1));
  const target = event.currentTarget.ownerDocument.getElementById(id);
  if (!target) return;
  if (!target.matches("a[href], [tabindex]")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
}

type Overflow = "none" | "left" | "right" | "both";

/** Which sides of a horizontal scroll box hide content (scroll positions can be fractional). */
function hiddenSides(node: HTMLElement): Overflow {
  const max = node.scrollWidth - node.clientWidth;
  if (max <= 1) return "none";
  const left = node.scrollLeft > 1;
  const right = node.scrollLeft < max - 1;
  return left && right ? "both" : left ? "left" : "right";
}

/**
 * Props for a box that may scroll sideways. While its content overflows it is a
 * named, focusable region so the keyboard can scroll it (not every engine makes
 * scroll containers focusable), and `data-overflow` names the sides that hide
 * content for the edge cue. While it fits it adds no tab stop.
 */
function useOverflowRegion<T extends HTMLElement>(label: string) {
  const ref = useRef<T>(null);
  const [overflow, setOverflow] = useState<Overflow>("none");
  // Content changes with every edit in the Preview, so measure after each render.
  useEffect(() => {
    if (ref.current) setOverflow(hiddenSides(ref.current));
  });
  // The box's width follows the viewport and the workspace panes; scrolling moves the hidden sides.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setOverflow(hiddenSides(node));
    const observer = new ResizeObserver(update);
    observer.observe(node);
    node.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
    };
  }, []);
  return overflow === "none"
    ? { ref }
    : { ref, role: "region", "aria-label": label, tabIndex: 0, "data-overflow": overflow };
}

function ScrollingTable({ node: _, ...props }: ComponentProps<"table"> & ExtraProps) {
  const region = useOverflowRegion<HTMLDivElement>("Scrollable table");
  return (
    <div className="markdown-scroll" {...region}>
      <table {...props} />
    </div>
  );
}

function ScrollingCode({ node: _, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const region = useOverflowRegion<HTMLPreElement>("Scrollable code");
  return <pre {...props} className="markdown-scroll" {...region} />;
}

const WEB_URL = /^https?:\/\//i;

const components: Components = {
  a: ({ node: _, href, ...props }) =>
    href?.startsWith("#") ? (
      <a {...props} href={href} onClick={followInPageLink} />
    ) : (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer" />
    ),
  // mdwn stores no images and its CSP admits only first-party ones, so an
  // embedded image could never load. Say so and keep its description; a web
  // address becomes a link the reader may choose to open.
  img: ({ src, alt }) => (
    <span className="markdown-image">
      <span className="markdown-image-label">Image not shown</span>
      {alt && <span>{alt}</span>}
      {typeof src === "string" && WEB_URL.test(src) && (
        <a href={src} target="_blank" rel="noopener noreferrer">
          Open image
        </a>
      )}
    </span>
  ),
  pre: ScrollingCode,
  table: ScrollingTable,
};
