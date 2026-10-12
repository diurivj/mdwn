import { cx } from "./cx";

/** Laboratorio recipes: square controls, thin rules and typewritten labels. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet" | "light" | "outline-light";
export type ButtonSize = "sm" | "md" | "lg";

export const buttonClass = (variant: ButtonVariant = "primary", size: ButtonSize = "md") =>
  cx(
    "inline-flex min-w-0 max-w-full items-center justify-center gap-2 whitespace-normal border text-center font-mono font-normal uppercase tracking-[0.06em] transition-colors disabled:cursor-not-allowed disabled:opacity-45",
    size === "lg"
      ? "min-h-13 px-6 py-3 text-[13px]"
      : size === "md"
        ? "min-h-11 px-4 py-2.5 text-xs"
        : "min-h-9 px-3 py-2 text-[11px]",
    variant === "primary" && "border-ink bg-ink text-paper hover:bg-ink-soft disabled:hover:bg-ink",
    variant === "secondary" &&
      "border-ink/40 bg-transparent text-ink hover:border-ink hover:bg-ink hover:text-paper disabled:hover:bg-transparent disabled:hover:text-ink",
    variant === "ghost" && "border-transparent text-ink-soft hover:bg-sand hover:text-ink",
    variant === "danger" && "border-danger bg-danger text-cream hover:bg-danger/90",
    variant === "danger-quiet" && "border-danger/50 text-danger hover:border-danger hover:bg-danger-soft",
    variant === "light" && "border-paper bg-paper text-ink hover:bg-cream",
    variant === "outline-light" && "border-paper/50 text-paper hover:border-paper hover:bg-paper/5",
  );

/** Small actions in dense panels keep readable mixed-case labels. */
export const textButtonClass = (tone: "default" | "danger" = "default") =>
  cx(
    "inline-flex items-center gap-1.5 px-2 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-45",
    tone === "danger" ? "text-danger hover:bg-danger-soft" : "text-ink-soft hover:bg-sand hover:text-ink",
  );

export const fieldClass = (size: "md" | "sm" = "md") =>
  cx(
    "field block w-full rounded-none border border-ink/40 bg-cream normal-case tracking-normal text-ink transition-colors placeholder:text-muted focus:border-ink focus:bg-white focus:outline-2 focus:outline-offset-2 focus:outline-ink disabled:cursor-not-allowed disabled:opacity-60",
    size === "md" ? "px-4 py-3 text-[15px]" : "px-3 py-2 text-sm",
  );

export const labelClass = "block font-mono text-xs uppercase tracking-[0.08em] text-ink";

export const linkClass = "text-ink underline underline-offset-4 transition-colors hover:text-ink-soft";

export type NoticeTone = "info" | "success" | "warning" | "danger";

export const noticeClass = (tone: NoticeTone = "info") =>
  cx(
    "border-l-2 px-4 py-3 text-sm leading-relaxed",
    tone === "info" && "border-ink bg-sand text-ink-soft",
    tone === "success" && "border-success bg-success-soft text-success",
    tone === "warning" && "border-warning bg-warning-soft text-warning",
    tone === "danger" && "border-danger bg-danger-soft text-danger",
  );
