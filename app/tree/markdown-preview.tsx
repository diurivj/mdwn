import { type ComponentProps, createContext, type MouseEvent, useContext, useEffect, useRef, useState } from "react";
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

/** GFM writes footnote ids percent-encoded, so try the fragment as written before decoding it, as HTML does. */
function inPageTarget(document: Document, fragment: string) {
  for (const candidate of [fragment, decodeFragment(fragment)]) {
    const target = document.getElementById(SANITIZED_ID_PREFIX + candidate);
    if (target) return target;
  }
  return null;
}

/**
 * Moves to a link's in-page target without touching the URL fragment: on a
 * Public page the fragment is the read capability, so following `#…` in place
 * or in a new tab would replace the key. Focus follows for keyboard and
 * screen-reader users; a target that doesn't exist does nothing.
 */
function followInPageLink(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const link = event.currentTarget;
  const target = inPageTarget(link.ownerDocument, link.getAttribute("href")!.slice(1));
  if (!target) return;
  if (!target.matches("a[href], [tabindex]")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
}

type HiddenSides = "none" | "left" | "right" | "both";

/** Which sides of a horizontal scroll box hide content (scroll positions can be fractional). */
function hiddenSides(node: HTMLElement): HiddenSides {
  const maxScrollLeft = node.scrollWidth - node.clientWidth;
  if (maxScrollLeft <= 1) return "none";
  const left = node.scrollLeft > 1;
  const right = node.scrollLeft < maxScrollLeft - 1;
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
  const [hidden, setHidden] = useState<HiddenSides>("none");
  // Content changes with every edit in the Preview, so measure after each render.
  useEffect(() => {
    if (ref.current) setHidden(hiddenSides(ref.current));
  });
  // The box's width follows the viewport and the workspace panes; scrolling moves the hidden sides.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setHidden(hiddenSides(node));
    const observer = new ResizeObserver(update);
    observer.observe(node);
    node.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener("scroll", update);
    };
  }, []);
  return hidden === "none"
    ? { ref }
    : { ref, role: "region", "aria-label": label, tabIndex: 0, "data-overflow": hidden };
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

/** Links that leave the document open apart from it and send no referrer. */
const OUTSIDE_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;

/** True inside a Markdown link, where an image's own link would nest one link in another. */
const InsideLink = createContext(false);

function MarkdownLink({ node: _, href, ...props }: ComponentProps<"a"> & ExtraProps) {
  return (
    <InsideLink value={true}>
      {href?.startsWith("#") ? (
        <a {...props} href={href} onClick={followInPageLink} />
      ) : (
        <a {...props} href={href} {...OUTSIDE_LINK} />
      )}
    </InsideLink>
  );
}

const WEB_URL = /^https?:\/\//i;

/**
 * mdwn stores no images and its CSP admits only first-party ones, so an
 * embedded image could never load. Say so and keep its description; a web
 * address becomes a link the reader may choose to open, unless the image is
 * already a link.
 */
function MarkdownImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  const insideLink = useContext(InsideLink);
  return (
    <span className="markdown-image">
      <span className="markdown-image-label">Image not shown</span>
      {alt && <span>{alt}</span>}
      {!insideLink && typeof src === "string" && WEB_URL.test(src) && (
        <a href={src} {...OUTSIDE_LINK}>
          Open image
        </a>
      )}
    </span>
  );
}

const components: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: ScrollingCode,
  table: ScrollingTable,
};
