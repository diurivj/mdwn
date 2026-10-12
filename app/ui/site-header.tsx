import { useRef, type ComponentType } from "react";
import { Form, Link, useLocation } from "react-router";

import type { Chrome } from "./chrome";
import { cx } from "./cx";
import {
  CloseIcon,
  DevicesIcon,
  FolderIcon,
  KeyIcon,
  MenuIcon,
  QrIcon,
  ShareIcon,
  ShieldIcon,
  SignOutIcon,
  UserIcon,
} from "./icons";
import { Logo } from "./logo";
import { SectionLink } from "./section-link";
import { useSessionPresence } from "./session-presence";
import { buttonClass } from "./styles";

type NavItem = { to: string; label: string; current?: (pathname: string) => boolean };

const PUBLIC_NAV: NavItem[] = [
  { to: "/#how-it-works", label: "How it works" },
  { to: "/#privacy", label: "Privacy" },
  { to: "/#publishing", label: "Publishing" },
  { to: "/support", label: "Support", current: (pathname) => pathname === "/support" },
];

const APP_NAV: NavItem[] = [
  {
    to: "/files",
    label: "Files",
    current: (pathname) => pathname === "/files" || pathname.startsWith("/d/") || pathname.startsWith("/f/"),
  },
  {
    to: "/account/security",
    label: "Account",
    current: (pathname) => pathname.startsWith("/account/") && pathname !== "/account/devices",
  },
  {
    to: "/account/devices",
    label: "Devices",
    current: (pathname) => pathname === "/account/devices" || pathname.startsWith("/enroll-device"),
  },
  { to: "/support", label: "Support", current: (pathname) => pathname === "/support" },
];

const ACCOUNT_LINKS: { to: string; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { to: "/files", label: "Your Files", icon: FolderIcon },
  { to: "/account/security", label: "Account security", icon: ShieldIcon },
  { to: "/account/devices", label: "Encryption devices", icon: DevicesIcon },
  { to: "/enroll-device/approve", label: "Approve a device", icon: QrIcon },
  { to: "/account/pseudonym", label: "Public pseudonym", icon: UserIcon },
  { to: "/account/shared-access", label: "Shared access", icon: ShareIcon },
  { to: "/account/key-rotations", label: "Secure access updates", icon: KeyIcon },
];

/**
 * The sticky site header. Navigation follows the browser's Session presence,
 * which is unknown during server rendering: public pages start on the public
 * navigation and Account/Files pages on the app navigation, so the common case
 * never flips after hydration.
 */
export function SiteHeader({ chrome }: { chrome: Exclude<Chrome, "reader"> }) {
  const presence = useSessionPresence();
  const signedIn = presence === "signed-in" || (presence === "unknown" && chrome !== "site");
  const { pathname } = useLocation();
  const menu = useRef<HTMLDialogElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);
  const nav = signedIn ? APP_NAV : PUBLIC_NAV;
  const closeMenu = () => menu.current?.close();
  const closeAccountMenu = () => accountMenu.current?.hidePopover();
  const onFiles = pathname === "/files" || pathname.startsWith("/d/") || pathname.startsWith("/f/");

  return (
    // A solid background rather than a translucent blur: blurring whatever scrolls
    // underneath costs a GPU pass on every frame and made scrolling stutter.
    <header className="sticky top-0 z-40 border-b border-ink bg-paper">
      <div
        className={cx(
          "grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-4 lg:flex lg:justify-between",
          chrome === "workspace" ? "px-4 sm:px-6" : "container-page",
        )}
      >
        <button
          type="button"
          onClick={() => menu.current?.showModal()}
          className="-ml-2 grid size-10 place-items-center transition-colors hover:bg-sand lg:hidden"
          aria-haspopup="dialog"
          aria-label="Open menu"
        >
          <MenuIcon className="size-5" />
        </button>

        <div className="justify-self-center lg:flex lg:items-center lg:gap-6 xl:gap-10">
          <Logo />
          <nav aria-label="Main" className="hidden lg:block">
            <ul className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.06em] xl:gap-3">
              {nav.map((item, index) => {
                const current = item.current?.(pathname) ?? false;
                return (
                  <li key={item.to}>
                    <SectionLink
                      to={item.to}
                      aria-current={current ? "page" : undefined}
                      className={cx(
                        "border-b px-2 py-2 transition-colors hover:border-ink hover:text-ink",
                        current ? "border-ink text-ink" : "border-transparent text-ink-soft",
                      )}
                    >
                      <span aria-hidden="true" className="mr-2 hidden text-muted xl:inline">
                        0{index + 1}
                      </span>
                      {item.label}
                    </SectionLink>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        <div className="-mr-1 flex items-center gap-2 justify-self-end">
          {signedIn ? (
            <>
              {!onFiles && (
                <Link to="/files" className={cx(buttonClass("primary", "sm"), "max-sm:hidden")}>
                  <FolderIcon />
                  Open Files
                </Link>
              )}
              <button
                type="button"
                popoverTarget="account-menu"
                className="grid size-10 place-items-center border border-ink/40 text-ink-soft transition-colors hover:border-ink hover:bg-sand hover:text-ink"
                aria-label="Account menu"
              >
                <UserIcon className="size-[18px]" />
              </button>
            </>
          ) : (
            <>
              <Link
                to="/sign-in"
                className={cx(buttonClass("ghost", "sm"), pathname === "/sign-in" && "bg-ink/[0.04] text-ink")}
              >
                Sign in
              </Link>
              <Link to="/sign-up" className={cx(buttonClass("primary", "sm"), "max-sm:hidden")}>
                Create account
              </Link>
            </>
          )}
        </div>
      </div>

      {signedIn && (
        <div id="account-menu" ref={accountMenu} popover="auto" className="menu-popover">
          <p className="eyebrow px-3 pb-2 pt-1.5 text-muted">Your account</p>
          <ul>
            {ACCOUNT_LINKS.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <Link
                  to={to}
                  onClick={closeAccountMenu}
                  aria-current={pathname === to ? "page" : undefined}
                  className="flex items-center gap-3 px-3 py-2.5 text-sm text-ink-soft transition-colors hover:bg-sand hover:text-ink aria-[current=page]:bg-sand aria-[current=page]:text-ink"
                >
                  <Icon className="size-4 text-muted" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
          {/* A navigation submission lets the editor's blocker save or ask before ending the Session. */}
          <Form method="post" action="/account/security" className="mt-1 border-t border-line pt-1">
            <button
              type="submit"
              name="intent"
              value="sign-out"
              onClick={closeAccountMenu}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-ink-soft transition-colors hover:bg-sand hover:text-ink"
            >
              <SignOutIcon className="size-4 text-muted" />
              Sign out
            </button>
          </Form>
        </div>
      )}

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a backdrop click is a pointer convenience; Escape and the labelled close button already dismiss the dialog from the keyboard. */}
      <dialog
        ref={menu}
        className="drawer"
        aria-label="Menu"
        // A click on the dialog element itself, not its content, is a click on the backdrop.
        onClick={(event) => event.target === event.currentTarget && closeMenu()}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-4 sm:px-6">
            <button
              type="button"
              onClick={closeMenu}
              className="-ml-2 grid size-10 place-items-center transition-colors hover:bg-sand"
              aria-label="Close menu"
            >
              <CloseIcon className="size-5" />
            </button>
            <Logo onClick={closeMenu} />
          </div>

          <nav aria-label="Main" className="flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6">
            <ul className="divide-y divide-line">
              {nav.map((item, index) => (
                <li key={item.to}>
                  <SectionLink
                    to={item.to}
                    onClick={closeMenu}
                    aria-current={item.current?.(pathname) ? "page" : undefined}
                    className="flex items-baseline gap-4 py-4 text-[1.75rem] font-light leading-tight transition-colors hover:bg-sand aria-[current=page]:underline"
                  >
                    <span aria-hidden="true" className="eyebrow text-muted">
                      0{index + 1}
                    </span>
                    {item.label}
                  </SectionLink>
                </li>
              ))}
            </ul>
            {signedIn && (
              <ul className="mt-4 space-y-1 border-t border-line pt-4 pb-6">
                {ACCOUNT_LINKS.slice(1).map(({ to, label, icon: Icon }) => (
                  <li key={to}>
                    <Link
                      to={to}
                      onClick={closeMenu}
                      className="flex items-center gap-3 py-2 text-sm text-ink-soft transition-colors hover:text-ink"
                    >
                      <Icon className="size-4 text-muted" />
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </nav>

          <div className="border-t border-line bg-cream/60 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 sm:px-6">
            {signedIn ? (
              <Form method="post" action="/account/security">
                <button
                  type="submit"
                  name="intent"
                  value="sign-out"
                  onClick={closeMenu}
                  className={cx(buttonClass("secondary"), "w-full")}
                >
                  <SignOutIcon />
                  Sign out
                </button>
              </Form>
            ) : (
              <div className="grid gap-3">
                <Link to="/sign-up" onClick={closeMenu} className={buttonClass("primary")}>
                  Create account
                </Link>
                <Link to="/sign-in" onClick={closeMenu} className={buttonClass("secondary")}>
                  Sign in
                </Link>
              </div>
            )}
            <p className="mt-4 text-xs leading-relaxed text-muted">
              End-to-end encrypted. Your Files are decrypted only in your browser.
            </p>
          </div>
        </div>
      </dialog>
    </header>
  );
}
