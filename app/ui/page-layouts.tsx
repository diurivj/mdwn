import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { cx } from "./cx";
import { useSessionPresence } from "./session-presence";

/** The serif page title with its eyebrow and optional lead paragraph. */
export function PageIntro({
  eyebrow,
  title,
  children,
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("max-w-2xl", className)}>
      {eyebrow && <p className="eyebrow text-accent">{eyebrow}</p>}
      <h1
        className={cx("font-serif text-4xl leading-[1.05] tracking-tight text-balance sm:text-5xl", eyebrow && "mt-3")}
      >
        {title}
      </h1>
      {children && <div className="mt-4 space-y-3 text-base leading-relaxed text-ink-soft">{children}</div>}
    </div>
  );
}

/** A titled group inside an Account page. */
export function SettingsSection({
  title,
  description,
  children,
  className,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <section className={cx("rounded-3xl bg-paper p-6 ring-1 ring-line sm:p-8", className)} {...props}>
      <h2 className="font-serif text-2xl leading-tight sm:text-[1.75rem]">{title}</h2>
      {description && <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink-soft">{description}</div>}
      {children}
    </section>
  );
}

const ACCOUNT_NAV = [
  { to: "/account/device-access", label: "Files access" },
  { to: "/account/security", label: "Account security" },
  { to: "/account/devices", label: "Encryption devices" },
  { to: "/enroll-device/approve", label: "Approve a device" },
  { to: "/account/pseudonym", label: "Public pseudonym" },
  { to: "/account/shared-access", label: "Shared access" },
  { to: "/account/key-rotations", label: "Secure access updates" },
];

/**
 * The Account area: its own navigation beside (or, on narrow screens, above) the
 * page. Renders the page's single <main> landmark.
 */
export function AccountLayout({ children, busy }: { children: ReactNode; busy?: boolean }) {
  const { pathname } = useLocation();
  // Account navigation leads nowhere without a Session: a signed-out visitor sees only the page.
  const signedOut = useSessionPresence() === "signed-out";
  return (
    <main
      className={cx(
        "container-page grid gap-8 pb-8 pt-8 sm:pt-12",
        !signedOut && "lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14",
      )}
      aria-busy={busy || undefined}
    >
      <nav aria-label="Account" hidden={signedOut} className="lg:sticky lg:top-28 lg:self-start">
        <p className="eyebrow hidden px-3 text-muted lg:block">Your account</p>
        <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:mt-3 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0">
          {ACCOUNT_NAV.map((item) => {
            const current = pathname === item.to;
            return (
              <li key={item.to} className="shrink-0">
                <Link
                  to={item.to}
                  aria-current={current ? "page" : undefined}
                  className={cx(
                    "block whitespace-nowrap rounded-full px-3.5 py-2 text-sm transition lg:rounded-xl lg:px-3",
                    current
                      ? "bg-ink text-paper lg:bg-cream lg:text-ink lg:shadow-[inset_2px_0_0_var(--color-accent)]"
                      : "bg-cream text-ink-soft hover:text-ink lg:bg-transparent lg:hover:bg-cream/70",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className={cx("min-w-0 animate-fade", signedOut && "mx-auto w-full max-w-2xl")}>{children}</div>
    </main>
  );
}

/** A focused, single-task page (sign in, sign up, recovery, enrollment). */
export function FocusLayout({
  children,
  aside,
  width = "narrow",
}: {
  children: ReactNode;
  aside?: ReactNode;
  width?: "narrow" | "wide";
}) {
  return (
    <main className="container-page py-12 sm:py-20">
      <div
        className={cx(
          "mx-auto grid items-start gap-10 lg:gap-16",
          aside
            ? "max-w-6xl lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]"
            : width === "wide"
              ? "max-w-3xl"
              : "max-w-xl",
        )}
      >
        {aside && <div className="animate-fade lg:pt-6">{aside}</div>}
        <div className="min-w-0 animate-fade">{children}</div>
      </div>
    </main>
  );
}

/** Loading placeholder lines for route fallbacks. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cx("space-y-3", className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative placeholders that never reorder.
          key={index}
          className="skeleton h-4"
          style={{ width: `${[92, 78, 64, 86, 70][index % 5]}%` }}
        />
      ))}
    </div>
  );
}
