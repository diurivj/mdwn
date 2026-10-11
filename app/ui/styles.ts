import { cx } from "./cx";

/**
 * Class recipes for the editorial design system. Components keep their own
 * markup and semantics; these keep buttons, fields and notices consistent.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet" | "light" | "outline-light";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonClass = (variant: ButtonVariant = "primary", size: ButtonSize = "md") =>
  cx(
    // The slight press-in is the immediate "got it" before a page, dialog or request responds.
    "inline-flex min-w-0 max-w-full items-center justify-center gap-2 whitespace-normal rounded-full text-center font-medium transition duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100",
    size === "lg"
      ? "min-h-13 px-7 py-3 text-[15px]"
      : size === "md"
        ? "min-h-11 px-5 py-2.5 text-sm"
        : "min-h-9 px-4 py-2 text-[13px]",
    variant === "primary" && "bg-ink text-paper hover:bg-ink-soft disabled:hover:bg-ink",
    variant === "secondary" &&
      "border border-ink/15 bg-paper text-ink hover:border-ink/40 hover:bg-ink/[0.03] disabled:hover:border-ink/15",
    variant === "ghost" && "text-ink-soft hover:bg-ink/5 hover:text-ink",
    variant === "danger" && "bg-danger text-paper hover:bg-danger/90",
    variant === "danger-quiet" && "border border-danger/30 text-danger hover:border-danger/60 hover:bg-danger-soft/60",
    variant === "light" && "bg-paper text-ink hover:bg-cream",
    variant === "outline-light" && "border border-paper/25 text-paper hover:border-paper/60 hover:bg-paper/5",
  );

/** Small text-style action inside dense panels (comment actions, list rows). */
export const textButtonClass = (tone: "default" | "danger" = "default") =>
  cx(
    "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45",
    tone === "danger" ? "text-danger hover:bg-danger-soft/70" : "text-ink-soft hover:bg-ink/5 hover:text-ink",
  );

export const fieldClass = (size: "md" | "sm" = "md") =>
  cx(
    "block w-full rounded-2xl border border-line bg-white/80 text-ink shadow-[inset_0_1px_2px_rgb(29_24_21/0.03)] transition placeholder:text-muted/70 focus:border-ink/35 focus:bg-white focus:outline-none focus:ring-4 focus:ring-petal/70 disabled:cursor-not-allowed disabled:opacity-60",
    size === "md" ? "px-4 py-3 text-[15px]" : "px-3 py-2 text-sm",
  );

export const labelClass = "block text-sm font-medium text-ink";

export const linkClass =
  "font-medium text-accent underline decoration-accent/35 underline-offset-4 transition hover:decoration-accent";

export type NoticeTone = "info" | "success" | "warning" | "danger";

export const noticeClass = (tone: NoticeTone = "info") =>
  cx(
    "rounded-2xl px-4 py-3 text-sm leading-relaxed",
    tone === "info" && "bg-cream text-ink-soft ring-1 ring-line",
    tone === "success" && "bg-success-soft text-success",
    tone === "warning" && "bg-warning-soft text-warning",
    tone === "danger" && "bg-danger-soft text-danger",
  );
