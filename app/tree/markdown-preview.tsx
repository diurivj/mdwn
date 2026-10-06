import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/** Browser-only rendering. Never parse raw HTML; sanitize plugin output as defense in depth. */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
            {children}
          </a>
        ),
      }}
    >
      {source}
    </Markdown>
  );
}
