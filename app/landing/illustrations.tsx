import { cx } from "~/ui/cx";
import { LockIcon } from "~/ui/icons";

/** A static specimen, not a second editor or a source of private content. */
export function EditorIllustration({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cx("min-w-0 border border-ink bg-cream", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink px-5 py-3">
        <p className="eyebrow text-muted">Specimen 01</p>
        <p className="font-mono text-[11px] uppercase tracking-wide">field-notes.md</p>
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <div className="min-w-0 break-words p-4 sm:p-6">
          <p className="eyebrow mb-6 text-muted">Source</p>
          <div className="space-y-3 font-mono text-[11px] leading-relaxed text-ink-soft sm:text-[13px]">
            <p># Field notes</p>
            <p>Tuesday, the **first** frost.</p>
            <p>
              - walk the long way
              <br />- finish chapter two
            </p>
            <p>&gt; Write for one reader.</p>
            <p>[ ] call the printer</p>
          </div>
        </div>
        <div className="min-w-0 break-words p-4 sm:p-6">
          <p className="eyebrow mb-6 text-muted">Preview</p>
          <p className="text-2xl font-light leading-none tracking-tight sm:text-3xl">Field notes</p>
          <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
            Tuesday, the <strong className="font-semibold text-ink">first</strong> frost.
          </p>
          <ul className="mt-3 space-y-1 text-[13px] text-ink-soft">
            <li>— walk the long way</li>
            <li>— finish chapter two</li>
          </ul>
          <p className="mt-4 border-l border-ink pl-3 text-sm leading-relaxed">Write for one reader.</p>
          <p className="mt-4 flex items-center gap-2 text-[13px] text-ink-soft">
            <span className="inline-block size-3 shrink-0 border border-muted" /> call the printer
          </p>
        </div>
      </div>
      <dl className="border-t border-ink font-mono text-[11px] uppercase tracking-wide sm:text-xs">
        {[
          ["Format", "Markdown / .md"],
          ["Encryption", "AES-256-GCM"],
          ["Keys", "On your devices"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[6rem_1fr] gap-3 border-b border-dashed border-line px-5 py-2.5 sm:grid-cols-[8rem_1fr]"
          >
            <dt className="text-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-start gap-3 bg-sand px-5 py-4">
        <LockIcon className="mt-0.5 size-4" />
        <p className="font-mono text-[11px] uppercase leading-relaxed tracking-wide">
          Sealed in your browser.
          <br />
          Only ciphertext leaves the page.
        </p>
      </div>
    </div>
  );
}

/** A Public link's fragment is the key; the URL example is entirely fictional. */
export function LinkIllustration({ className }: { className?: string }) {
  return (
    <figure className={cx("min-w-0 border border-ink bg-cream", className)}>
      <div aria-hidden="true">
        <p className="eyebrow border-b border-ink px-5 py-3 text-muted">Specimen 02 — Public link</p>
        <div className="border-b border-line p-5 sm:p-8">
          <p className="break-all font-mono text-xs leading-loose text-ink-soft">
            mdwn.me/p/Q2x8vR4mT0kZ…<span className="border-b border-ink text-ink">#v1.k3Ff9wQ…</span>
          </p>
          <p className="mt-8 text-3xl font-light leading-tight tracking-tight sm:text-4xl">Spring reading list</p>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-wide text-muted">By Quiet Heron · read-only</p>
          <div className="mt-6 space-y-2">
            <span className="block h-2 w-11/12 bg-sand" />
            <span className="block h-2 w-4/5 bg-sand" />
            <span className="block h-2 w-3/5 bg-sand" />
          </div>
        </div>
        <dl className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className="min-w-0 px-5 py-5">
            <dt className="eyebrow text-muted">Sent to mdwn</dt>
            <dd className="mt-3 break-all font-mono text-xs">/p/Q2x8vR4mT0kZ…</dd>
          </div>
          <div className="min-w-0 bg-sand px-5 py-5">
            <dt className="eyebrow text-muted">Stays in the browser</dt>
            <dd className="mt-3 break-all font-mono text-xs">#v1.k3Ff9wQ… (the key)</dd>
          </div>
        </dl>
      </div>
      <figcaption className="border-t border-ink px-5 py-4 text-xs leading-relaxed text-muted">
        Browsers never send the part of a link after #, so the key to a Public page stays with its readers.
      </figcaption>
    </figure>
  );
}
