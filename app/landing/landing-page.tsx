import type { ComponentType } from "react";
import { Link } from "react-router";

import { cx } from "~/ui/cx";
import {
  ArrowRightIcon,
  CheckIcon,
  CommentIcon,
  DevicesIcon,
  DownloadIcon,
  FolderIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  UploadIcon,
} from "~/ui/icons";
import { SectionHeading } from "~/ui/section-heading";
import { SectionLink } from "~/ui/section-link";
import { buttonClass } from "~/ui/styles";
import { EditorIllustration, LinkIllustration } from "./illustrations";

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;

const PROMISES: { icon: Icon; title: string; text: string }[] = [
  {
    icon: LockIcon,
    title: "Encrypted in your browser",
    text: "Markdown, File and folder names, and comments are sealed before they leave this page.",
  },
  {
    icon: KeyIcon,
    title: "Passkeys, not passwords",
    text: "Sign in with your device. There is no password to phish, reuse, or leak.",
  },
  {
    icon: DevicesIcon,
    title: "Every device, approved by you",
    text: "Add a browser by scanning a QR code on one you trust. Remove any device later.",
  },
  {
    icon: GlobeIcon,
    title: "Publish one page at a time",
    text: "A read-only public link whose key never reaches our servers.",
  },
];

const STEPS = [
  {
    title: "Create an account with a passkey",
    text: "Your device generates the keys. There is no password, because there is nothing for us to check it against.",
  },
  {
    title: "Keep your recovery phrase",
    text: "Twenty-four words and ten one-time codes, shown once and kept offline by you — never by us.",
  },
  {
    title: "Write, organize, publish",
    text: "Keep Files in folders, open them on every device you approve, and publish a page when it is ready.",
  },
];

const FEATURES: { icon: Icon; title: string; text: string; tile: string }[] = [
  {
    icon: PencilIcon,
    title: "Write",
    text: "A calm editor with live preview and autosave. Every File holds up to 256 KiB of Markdown.",
    tile: "bg-floral-soft",
  },
  {
    icon: FolderIcon,
    title: "Organize",
    text: "Folders and Files you can rename, move and reorder. Their names are encrypted too.",
    tile: "bg-fresco-soft",
  },
  {
    icon: GlobeIcon,
    title: "Publish",
    text: "Turn a File into a clean public page, live with every save, and take it down whenever you like.",
    tile: "bg-dulce-soft",
  },
  {
    icon: CommentIcon,
    title: "Discuss",
    text: "Each File keeps a private comment thread; a published page gets its own, separate public one.",
    tile: "bg-amaderado-soft",
  },
  {
    icon: DownloadIcon,
    title: "Export",
    text: "Download every File you own as a portable archive, whenever you like.",
    tile: "bg-sand",
  },
  {
    icon: UploadIcon,
    title: "Import",
    text: "Bring Markdown files, folders or an mdwn archive. You review it all before anything uploads.",
    tile: "bg-petal/70",
  },
];

const QUESTIONS = [
  {
    question: "Can mdwn read my Files?",
    answer:
      "No. Your Markdown, the names of your Files and folders, and your comments are encrypted in your browser with keys that stay on your devices. We store ciphertext, plus what any service must know to run: that your account exists, roughly how much it stores, and when it is used.",
  },
  {
    question: "What happens if I lose my passkey?",
    answer:
      "Use one of your ten one-time recovery codes to add a new passkey. Recovery codes restore sign-in only; on a new browser you still unlock your Files with another device or your recovery phrase.",
  },
  {
    question: "What is the 24-word recovery phrase for?",
    answer:
      "It restores access to your encrypted Files on a new browser when no other device is available. It never leaves your browser, and nobody — including us — can reset it for you.",
  },
  {
    question: "Can I use mdwn on more than one device?",
    answer:
      "Yes. Approve a new browser from one you already use by scanning a QR code. Each device holds its own keys, and you can remove any of them later.",
  },
  {
    question: "Who can read a published page?",
    answer:
      "Anyone with its complete link. The part after # is the key, and browsers never send it to us. Rotating the link retires the old one; unpublishing deletes the public copy and its public comments.",
  },
  {
    question: "How is mdwn paid for?",
    answer:
      "It isn’t monetized: no ads, no tracking, no paid tier. Optional, anonymous donations help with the domain, and mdwn works exactly the same whether or not anyone donates.",
  },
];

export function LandingPage() {
  return (
    <main>
      <Hero />
      <TrustBar />
      <HowItWorks />
      <Privacy />
      <Features />
      <Publishing />
      <Questions />
      <FinalCall />
    </main>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* A soft glow drawn as a gradient: a blur() filter this size is costly to paint. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-96 -right-96 size-[60rem] bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-petal)_55%,transparent)_35%,transparent)]"
      />
      <div className="container-page relative grid grid-cols-1 items-center gap-20 pt-12 pb-24 sm:pt-16 lg:grid-cols-12 lg:gap-12 lg:pt-24 lg:pb-28">
        <div className="min-w-0 animate-rise lg:col-span-6">
          <p className="eyebrow text-accent">End-to-end encrypted Markdown</p>
          <h1 className="mt-5 font-serif text-[3rem] leading-[0.98] tracking-tight text-balance sm:text-6xl lg:text-[4.75rem]">
            Write in Markdown. <em className="text-accent">Keep the key.</em>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-ink-soft">
            mdwn is a private home for your writing. Organize your Files, reach them from every device you approve, and
            publish a page when you want to — everything is sealed in your browser before it reaches us.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Link to="/sign-up" className={buttonClass("primary", "lg")}>
              Create your account <ArrowRightIcon />
            </Link>
            <SectionLink to="/#how-it-works" className={buttonClass("secondary", "lg")}>
              How it works
            </SectionLink>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-soft">
            {["Passkeys only", "Encrypted before upload", "No ads or tracking"].map((check) => (
              <li key={check} className="flex items-center gap-2">
                <CheckIcon className="text-success" /> {check}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 animate-rise [animation-delay:120ms] lg:col-span-6">
          <EditorIllustration className="mx-auto max-w-xl lg:max-w-none" />
        </div>
      </div>
    </section>
  );
}

function TrustBar() {
  return (
    <section aria-label="What mdwn promises" className="border-y border-line bg-cream/70">
      <ul className="container-page grid grid-cols-1 gap-x-8 gap-y-7 py-9 sm:grid-cols-2 lg:grid-cols-4">
        {PROMISES.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3">
            <Icon className="mt-0.5 size-5 text-accent" strokeWidth={1.6} />
            <div>
              <p className="text-sm font-medium">{title}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title" className="container-page py-20 sm:py-28">
      <SectionHeading
        id="how-it-works-title"
        eyebrow="How it works"
        title="Three steps, and not one password"
        align="center"
      >
        Setting up takes about a minute. The only things to keep safe are the ones only you should have.
      </SectionHeading>
      <ol className="mt-16 grid gap-12 md:grid-cols-3 md:gap-8">
        {STEPS.map((step, index) => (
          <li key={step.title} className="text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full bg-paper font-serif text-2xl ring-1 ring-line">
              {index + 1}
            </span>
            <h3 className="mt-5 font-serif text-2xl leading-tight">{step.title}</h3>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-soft">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Privacy() {
  return (
    <section id="privacy" aria-labelledby="privacy-title" className="bg-wine text-paper">
      <div className="container-page py-20 sm:py-28">
        <SectionHeading
          id="privacy-title"
          tone="light"
          eyebrow="What we can’t see"
          title="Your words never reach us readable"
        >
          Most notes apps keep the keys to your writing. mdwn encrypts it on your device first, so our servers only ever
          hold ciphertext.
        </SectionHeading>

        <div className="mt-14 grid gap-4 lg:grid-cols-2">
          <DataPath
            label="A typical notes app"
            steps={["Your words", "Their servers", "Readable there"]}
            extras={["Staff and tools can read it", "A breach exposes it", "It can be mined"]}
            verdict="Private by policy."
          />
          <DataPath
            label="mdwn"
            steps={["Your words", "Sealed in your browser", "Ciphertext on our servers"]}
            extras={["Keys stay on your devices", "Names are encrypted too", "Nothing to sell"]}
            verdict="Private by construction."
            ours
          />
        </div>

        <div className="mt-16 grid gap-10 border-t border-paper/10 pt-12 md:grid-cols-3 md:gap-8">
          {[
            {
              title: "Keys live on your devices",
              text: "Each browser holds its own non-exportable keys. Adding a device is something you approve, on a device you already trust.",
            },
            {
              title: "Even names are encrypted",
              text: "File names, folder names, ordering, front matter and comments are sealed alongside the Markdown itself.",
            },
            {
              title: "Nothing to sell",
              text: "No ads, no analytics, no trackers, no paid tier. There is no business that depends on reading you.",
            },
          ].map((reason, index) => (
            <div key={reason.title}>
              <p className="font-serif text-5xl text-petal/50">0{index + 1}</p>
              <h3 className="mt-3 text-lg font-medium text-paper">{reason.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-paper/70">{reason.text}</p>
            </div>
          ))}
        </div>

        <p className="mt-16 max-w-3xl font-serif text-3xl italic leading-tight text-petal sm:text-4xl">
          Your writing is encrypted before upload. We store ciphertext, not the keys to read it.
        </p>
        <p className="mt-5 max-w-3xl text-sm leading-relaxed text-paper/70">
          This protects stored content, not a compromised browser, malicious extension, or altered app code. Your
          browser and the code it runs remain part of the trust boundary.
        </p>
      </div>
    </section>
  );
}

function DataPath({
  label,
  steps,
  extras,
  verdict,
  ours = false,
}: {
  label: string;
  steps: string[];
  extras: string[];
  verdict: string;
  ours?: boolean;
}) {
  return (
    <div
      className={cx(
        "flex flex-col rounded-3xl p-6 sm:p-8",
        ours ? "bg-paper text-ink" : "bg-paper/[0.04] text-paper ring-1 ring-paper/10",
      )}
    >
      <p className={cx("eyebrow", ours ? "text-accent" : "text-paper/60")}>{label}</p>
      <ol className="mt-6 flex flex-wrap items-center gap-x-1.5 gap-y-2.5 sm:gap-x-2">
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-1.5 sm:gap-2">
            <span
              className={cx(
                "rounded-full px-3 py-1.5 text-[13px] sm:px-3.5 sm:py-2 sm:text-sm",
                ours && index === 1 ? "bg-ink font-medium text-paper" : ours ? "bg-sand" : "bg-paper/10",
              )}
            >
              {step}
            </span>
            {index < steps.length - 1 && <ArrowRightIcon className="size-3.5 opacity-40 sm:size-4" />}
          </li>
        ))}
      </ol>
      <ul className="mt-6 flex flex-wrap gap-2">
        {extras.map((extra) => (
          <li
            key={extra}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs",
              ours ? "bg-success/10 text-success" : "bg-accent/30 text-petal",
            )}
          >
            {ours ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
            {extra}
          </li>
        ))}
      </ul>
      <p className={cx("mt-auto pt-8 font-serif text-2xl", ours ? "text-ink" : "text-paper/80")}>{verdict}</p>
    </div>
  );
}

function Features() {
  return (
    <section aria-labelledby="features-title" className="container-page py-20 sm:py-28">
      <SectionHeading
        id="features-title"
        eyebrow="Everything Markdown needs"
        title="A quiet place for serious writing"
        action={
          <Link to="/sign-up" className={buttonClass("secondary")}>
            Start writing <ArrowRightIcon />
          </Link>
        }
      >
        No feeds, no plug-ins, no lock-in. Just your Files, the pages you choose to publish, and a way to take
        everything with you.
      </SectionHeading>
      <ul className="mt-12 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, text, tile }) => (
          <li key={title} className={cx("flex flex-col rounded-3xl p-6 sm:p-7", tile)}>
            <span className="grid size-11 place-items-center rounded-full bg-paper/80 text-accent ring-1 ring-ink/5">
              <Icon className="size-5" strokeWidth={1.6} />
            </span>
            <h3 className="mt-6 font-serif text-[1.75rem] leading-tight">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Publishing() {
  return (
    <section id="publishing" aria-labelledby="publishing-title" className="border-y border-line bg-cream/50">
      <div className="container-page grid items-center gap-14 py-20 sm:py-28 lg:grid-cols-12 lg:gap-12">
        <div className="lg:col-span-6">
          <SectionHeading
            id="publishing-title"
            eyebrow="Publishing"
            title="Publish one page. The key travels in the link."
          >
            When a File is ready for the world, publish it. Readers open a clean, read-only page that decrypts in their
            browser — no account needed.
          </SectionHeading>
          <ol className="mt-10 space-y-6">
            {[
              {
                title: "Publish a File",
                text: "One click creates a read-only public link to its latest saved version.",
              },
              {
                title: "Share the complete link",
                text: "Everything after # is the key. Browsers never send it, so we never have it.",
              },
              {
                title: "Rotate or unpublish anytime",
                text: "Retire a leaked link instantly, or delete the public copy and its comments for good.",
              },
            ].map((step, index) => (
              <li key={step.title} className="flex gap-5">
                <span className="w-9 shrink-0 font-serif text-3xl leading-none tabular-nums text-accent/70">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="font-medium">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-soft">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <LinkIllustration className="lg:col-span-6" />
      </div>
    </section>
  );
}

function Questions() {
  return (
    <section id="questions" aria-labelledby="questions-title" className="container-page py-20 sm:py-28">
      <div className="grid gap-12 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <SectionHeading id="questions-title" eyebrow="Questions" title="Before you trust us with your words" />
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-ink-soft">
            Your writing is encrypted in your browser before upload. Here’s what that protects, and what stays in your
            hands.
          </p>
        </div>
        <div className="lg:col-span-8">
          <div className="divide-y divide-line border-y border-line">
            {QUESTIONS.map((faq) => (
              <details key={faq.question} className="disclosure group">
                <summary className="flex items-center justify-between gap-6 py-5 font-serif text-xl leading-snug sm:text-2xl">
                  {faq.question}
                  <PlusIcon className="size-5 text-muted transition-transform duration-300 group-open:rotate-45" />
                </summary>
                <p className="max-w-3xl pb-6 leading-relaxed text-ink-soft">{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCall() {
  return (
    <section className="container-page">
      <div className="relative isolate overflow-hidden rounded-[2rem] bg-petal px-6 py-16 text-center sm:px-12 sm:py-24">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 left-1/2 -z-10 size-[36rem] -translate-x-1/2 bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-paper)_70%,transparent),transparent)]"
        />
        <p className="eyebrow text-accent">Free, private, portable</p>
        <h2 className="mx-auto mt-4 max-w-3xl font-serif text-4xl leading-[1.04] tracking-tight text-balance sm:text-6xl">
          Your writing, <em className="text-accent">sealed</em> and yours to take anywhere.
        </h2>
        <p className="mx-auto mt-5 max-w-lg text-ink-soft">
          Create an account in a minute with a passkey. Export everything you own whenever you like.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link to="/sign-up" className={buttonClass("primary", "lg")}>
            Create your account <ArrowRightIcon />
          </Link>
          <Link to="/sign-in" className={buttonClass("light", "lg")}>
            I already have one
          </Link>
        </div>
      </div>
    </section>
  );
}
