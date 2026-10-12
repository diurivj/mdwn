import { Link } from "react-router";

import { cx } from "./cx";

/** A plain wordmark, matching Laboratorio's restrained sans-serif masthead. */
export function Logo({ className, onClick }: { className?: string; onClick?: () => void }) {
  return (
    <Link
      to="/"
      onClick={onClick}
      className={cx("whitespace-nowrap text-[24px] font-medium leading-none tracking-tight", className)}
    >
      mdwn
    </Link>
  );
}
