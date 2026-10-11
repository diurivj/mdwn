import { Link } from "react-router";

import { LockIcon } from "./icons";
import { SectionLink } from "./section-link";

const PRODUCT_LINKS = [
  { to: "/#how-it-works", label: "How it works" },
  { to: "/#privacy", label: "What we can’t see" },
  { to: "/#publishing", label: "Publishing" },
  { to: "/#questions", label: "Questions" },
];

const ACCESS_LINKS = [
  { to: "/sign-up", label: "Create account" },
  { to: "/sign-in", label: "Sign in" },
  { to: "/files", label: "Open your Files" },
  { to: "/recover", label: "Recover your Account" },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 bg-wine text-paper/75">
      <div className="container-page grid gap-12 py-16 md:grid-cols-12">
        <div className="md:col-span-5">
          <Link to="/" className="font-serif text-4xl leading-none text-paper">
            md<span className="italic text-petal">w</span>n
          </Link>
          <p className="mt-4 max-w-sm text-sm leading-relaxed">
            A private home for your Markdown. Write, organize, and publish one page at a time — encrypted in your
            browser before anything leaves it.
          </p>
          <p className="mt-5 flex items-start gap-2 text-sm">
            <LockIcon className="mt-0.5 text-petal" />
            Passkeys only. No passwords, ads, trackers, or analytics.
          </p>
        </div>

        <nav aria-label="Product" className="md:col-span-2 md:col-start-7">
          <p className="eyebrow text-paper/50">Product</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            {PRODUCT_LINKS.map((link) => (
              <li key={link.to}>
                <SectionLink to={link.to} className="transition hover:text-paper">
                  {link.label}
                </SectionLink>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Access" className="md:col-span-2">
          <p className="eyebrow text-paper/50">Access</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            {ACCESS_LINKS.map((link) => (
              <li key={link.to}>
                <Link to={link.to} className="transition hover:text-paper">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="md:col-span-2">
          <p className="eyebrow text-paper/50">Independent</p>
          <p className="mt-4 text-sm leading-relaxed">Never monetized. Optional, anonymous donations only.</p>
          <Link
            to="/support"
            className="mt-3 inline-block text-sm text-paper underline decoration-petal/50 underline-offset-4 transition hover:decoration-petal"
          >
            Support mdwn
          </Link>
        </div>
      </div>

      <div className="border-t border-paper/10">
        <div className="container-page flex flex-col gap-2 py-6 text-xs text-paper/50 sm:flex-row sm:items-center sm:justify-between">
          <p>mdwn · private Markdown, end to end</p>
          <p>Private content is decrypted only in your browser.</p>
        </div>
      </div>
    </footer>
  );
}
