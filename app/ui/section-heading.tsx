import type { ReactNode } from "react";

import { cx } from "./cx";

/** A typewritten section label, a light heading and an optional lead. */
export function SectionHeading({
  eyebrow,
  title,
  children,
  action,
  align = "left",
  tone = "dark",
  id,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  align?: "left" | "center";
  tone?: "dark" | "light";
  id?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col gap-6",
        align === "center" ? "items-center text-center" : "md:flex-row md:items-end md:justify-between",
      )}
    >
      <div className={cx("max-w-2xl", align === "center" && "mx-auto")}>
        <p className={cx("eyebrow", tone === "dark" ? "text-muted" : "text-paper/75")}>{eyebrow}</p>
        <h2
          id={id}
          className="mt-6 font-display text-4xl font-light leading-[0.98] tracking-[-0.035em] text-balance sm:text-5xl"
        >
          {title}
        </h2>
        {children && (
          <p
            className={cx(
              "mt-4 text-base leading-relaxed text-pretty sm:text-lg",
              tone === "dark" ? "text-ink-soft" : "text-paper/75",
            )}
          >
            {children}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
