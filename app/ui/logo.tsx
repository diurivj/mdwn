import { Link } from "react-router";

import { cx } from "./cx";

/** The serif wordmark; its italic accent letter echoes Markdown's own emphasis. */
export function Logo({ className, onClick }: { className?: string; onClick?: () => void }) {
  return (
    <Link
      to="/"
      onClick={onClick}
      className={cx("whitespace-nowrap font-serif text-[28px] leading-none tracking-tight", className)}
    >
      md<span className="italic text-accent">w</span>n
    </Link>
  );
}
