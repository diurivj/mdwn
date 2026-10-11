import { cx } from "~/ui/cx";
import { CheckIcon, LockIcon } from "~/ui/icons";

/** A decorative editor window: Markdown on the left, its preview on the right, ciphertext below. */
export function EditorIllustration({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cx("relative", className)}>
      <div className="overflow-hidden rounded-[1.75rem] bg-paper shadow-[0_48px_90px_-48px_rgb(29_24_21/0.5)] ring-1 ring-line">
        <div className="flex items-center gap-3 border-b border-line bg-cream/80 px-4 py-3 sm:px-5">
          <div className="flex shrink-0 gap-1.5">
            <span className="size-2.5 rounded-full bg-line" />
            <span className="size-2.5 rounded-full bg-line" />
            <span className="size-2.5 rounded-full bg-line" />
          </div>
          <p className="truncate font-mono text-[11px] text-muted">notes / field-notes.md</p>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-[11px] font-medium text-success">
            <span className="size-1.5 rounded-full bg-success" />
            Saved
          </span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-line">
          <div className="min-w-0 space-y-2.5 break-words bg-white/55 p-4 font-mono text-[10px] leading-relaxed text-ink-soft sm:p-5 sm:text-[11.5px]">
            <p>
              <span className="text-accent"># </span>Field notes
            </p>
            <p>
              Tuesday, the <span className="text-accent">**</span>first<span className="text-accent">**</span> frost.
            </p>
            <p>
              <span className="text-accent">- </span>walk the long way
            </p>
            <p>
              <span className="text-accent">- </span>finish chapter two
            </p>
            <p>
              <span className="text-accent">&gt; </span>Write for one reader.
            </p>
            <p className="flex items-center gap-1">
              <span className="text-accent">[ ]</span> call the printer
              <span className="ml-0.5 inline-block h-3.5 w-px animate-pulse bg-ink" />
            </p>
          </div>
          <div className="min-w-0 break-words p-4 sm:p-5">
            <p className="font-serif text-[1.4rem] leading-none text-ink sm:text-[1.65rem]">Field notes</p>
            <p className="mt-3 text-[12px] leading-relaxed text-ink-soft sm:text-[12.5px]">
              Tuesday, the <strong className="font-semibold text-ink">first</strong> frost.
            </p>
            <ul className="mt-2 space-y-1 text-[12px] text-ink-soft sm:text-[12.5px]">
              <li className="flex gap-2">
                <span className="text-accent">•</span> walk the long way
              </li>
              <li className="flex gap-2">
                <span className="text-accent">•</span> finish chapter two
              </li>
            </ul>
            <p className="mt-3 border-l-2 border-accent pl-3 font-serif text-[15px] italic leading-snug text-ink">
              Write for one reader.
            </p>
            <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-soft">
              <span className="inline-block size-3 rounded-[3px] ring-1 ring-muted/60" /> call the printer
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 overflow-hidden border-t border-line bg-wine px-5 py-3 font-mono text-[10.5px] text-petal/60">
          <span className="shrink-0 text-petal">stored as</span>
          <span className="truncate">
            9f3a c41e 02bd 9e77 a1f0 5c2d e9b4 71aa 0c6f 3b18 d2e5 8a94 6f01 b7c3 44de 19a0
          </span>
        </div>
      </div>

      <div className="absolute -bottom-8 right-3 rounded-2xl bg-paper px-4 py-3 shadow-[0_16px_40px_-14px_rgb(29_24_21/0.3)] ring-1 ring-ink/5 sm:right-8">
        <span className="eyebrow block text-muted">Sealed in your browser</span>
        <span className="mt-1 flex items-center gap-2 text-sm font-medium">
          <LockIcon className="text-accent" /> AES-256-GCM, before upload
        </span>
      </div>

      <RotatingBadge
        text="End-to-end encrypted · passkeys only ·"
        className="absolute -top-9 -right-2 size-26 sm:-right-5 sm:size-32"
      />
    </div>
  );
}

function RotatingBadge({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx("grid place-items-center rounded-full bg-ink text-paper shadow-lg", className)}>
      <svg viewBox="0 0 100 100" aria-hidden="true" className="absolute inset-0 size-full animate-spin-slow">
        <defs>
          <path id="badge-ring" d="M50,50 m-37,0 a37,37 0 1,1 74,0 a37,37 0 1,1 -74,0" />
        </defs>
        <text className="fill-current text-[7.6px] font-medium uppercase tracking-[0.16em]">
          <textPath href="#badge-ring" textLength="230" lengthAdjust="spacing">
            {text}
          </textPath>
        </text>
      </svg>
      <span className="font-serif text-[1.55rem] italic leading-none text-petal sm:text-[1.9rem]">e2e</span>
    </div>
  );
}

/** A Public link with its fragment called out: the key that never reaches the service. */
export function LinkIllustration({ className }: { className?: string }) {
  return (
    <figure className={cx("rounded-3xl bg-cream p-5 sm:p-8", className)}>
      <div aria-hidden="true">
        <div className="rounded-2xl bg-paper p-3 shadow-[0_18px_40px_-28px_rgb(29_24_21/0.45)] ring-1 ring-line">
          <div className="flex items-center gap-2 rounded-xl bg-cream px-3 py-2.5 font-mono text-[11px] sm:text-[12.5px]">
            <LockIcon className="size-3.5 text-success" />
            <span className="truncate text-ink-soft">
              mdwn.me/p/Q2x8vR4mT0kZ…
              <span className="rounded-md bg-petal px-1 py-0.5 text-accent ring-1 ring-accent/30">#v1.k3Ff9wQ…</span>
            </span>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-4 px-2 pb-2">
            <div>
              <p className="font-serif text-2xl leading-none sm:text-3xl">Spring reading list</p>
              <p className="mt-2 text-xs text-muted">By Quiet Heron · read-only</p>
              <div className="mt-4 space-y-2">
                <span className="block h-2 w-11/12 rounded-full bg-sand" />
                <span className="block h-2 w-4/5 rounded-full bg-sand" />
                <span className="block h-2 w-3/5 rounded-full bg-sand" />
              </div>
            </div>
            <span className="hidden rounded-full bg-success-soft px-3 py-1.5 text-[11px] font-medium text-success sm:inline-flex sm:items-center sm:gap-1.5">
              <CheckIcon className="size-3.5" /> Decrypted here
            </span>
          </div>
        </div>
        <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <p className="rounded-2xl bg-paper px-4 py-3 ring-1 ring-line">
            <span className="eyebrow block text-muted">Sent to mdwn</span>
            <span className="mt-1 block font-mono text-xs text-ink-soft">/p/Q2x8vR4mT0kZ…</span>
          </p>
          <p className="rounded-2xl bg-petal/70 px-4 py-3 ring-1 ring-accent/20">
            <span className="eyebrow block text-accent">Stays in the browser</span>
            <span className="mt-1 block font-mono text-xs text-ink">#v1.k3Ff9wQ… (the key)</span>
          </p>
        </div>
      </div>
      <figcaption className="mt-4 text-center text-xs text-muted">
        Browsers never send the part of a link after #, so the key to a Public page stays with its readers.
      </figcaption>
    </figure>
  );
}
