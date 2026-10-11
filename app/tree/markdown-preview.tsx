import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * Browser-only rendering. Never parse raw HTML; sanitize plugin output as defense in depth.
 * Typography comes from the surrounding `.prose-editorial` container (app/app.css).
 */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {source}
    </Markdown>
  );
}
