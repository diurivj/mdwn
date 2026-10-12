import { Link } from "react-router";

import { ArrowRightIcon, PlusIcon } from "~/ui/icons";
import { SectionHeading } from "~/ui/section-heading";
import { SectionLink } from "~/ui/section-link";
import { buttonClass } from "~/ui/styles";
import { EditorIllustration, LinkIllustration } from "./illustrations";

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

const FEATURES = [
  {
    title: "Write",
    text: "A calm editor with live preview and autosave. Every File holds up to 256 KiB of Markdown.",
    detail: ".md / 256 KiB",
  },
  {
    title: "Organize",
    text: "Folders and Files you can rename, move and reorder. Their names are encrypted too.",
    detail: "Files + folders",
  },
  {
    title: "Publish",
    text: "Turn a File into a clean public page, live with every save, and take it down whenever you like.",
    detail: "Read-only link",
  },
  {
    title: "Discuss",
    text: "Each File keeps a private comment thread; a published page gets its own, separate public one.",
    detail: "Separate threads",
  },
  {
    title: "Export",
    text: "Download every File you own as a portable archive, whenever you like.",
    detail: "Portable archive",
  },
  {
    title: "Import",
    text: "Bring Markdown files, folders or an mdwn archive. You review it all before anything uploads.",
    detail: "Review first",
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
      <Why />
      <HowItWorks />
      <Features />
      <Privacy />
      <Publishing />
      <Questions />
      <FinalCall />
    </main>
  );
}

function Hero() {
  return (
    <section className="border-b border-ink">
      <div className="container-page grid lg:grid-cols-12">
        <div className="min-w-0 py-12 sm:py-16 lg:col-span-5 lg:border-r lg:border-ink lg:py-20 lg:pr-10">
          <p className="eyebrow text-muted">Private Markdown</p>
          <h1 className="mt-8 max-w-xl font-display text-[3.25rem] font-light leading-[0.95] tracking-[-0.035em] text-balance sm:text-7xl lg:text-[4.5rem] xl:text-[5.25rem]">
            Write in Markdown. Keep the key.
          </h1>
          <p className="mt-7 max-w-md text-[15px] leading-relaxed text-ink-soft">
            mdwn is a private home for your writing. Organize your Files, reach them from every device you approve, and
            publish a page when you want to — everything is sealed in your browser before it reaches us.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link to="/sign-up" className={buttonClass("primary", "lg")}>
              Create your account <ArrowRightIcon />
            </Link>
            <SectionLink to="/#how-it-works" className={buttonClass("secondary", "lg")}>
              How it works
            </SectionLink>
          </div>
          <p className="mt-8 font-mono text-[11px] uppercase leading-loose tracking-wide text-muted">
            Passkeys only · No ads or tracking
            <br />
            End-to-end encrypted Markdown
          </p>
        </div>
        <div className="min-w-0 border-t border-ink py-10 lg:col-span-7 lg:flex lg:items-center lg:border-t-0 lg:py-16 lg:pl-10 xl:pl-16">
          <EditorIllustration className="w-full" />
        </div>
      </div>
    </section>
  );
}

function Why() {
  return (
    <section
      id="why"
      aria-labelledby="why-title"
      className="border-b border-ink bg-ink text-paper selection:bg-paper selection:text-ink"
    >
      <div className="container-page grid gap-8 py-16 sm:py-24 lg:grid-cols-12 lg:gap-10">
        <p className="eyebrow text-paper/70 lg:col-span-4 lg:pt-3">Why we built mdwn</p>
        <div className="lg:col-span-8">
          <h2
            id="why-title"
            className="font-display text-[2.5rem] font-light leading-[1.02] tracking-[-0.035em] text-balance sm:text-6xl"
          >
            In this agentic era, the only human thing we can defend is our privacy.
          </h2>
          <div className="mt-10 grid gap-6 border-t border-paper/25 pt-8 text-[15px] leading-relaxed text-paper/75 md:grid-cols-2 md:gap-10">
            <p>
              Agents now read, summarize and learn from almost everything we put online. Drafts become training data,
              notes become someone else’s context, and the unfinished thinking that makes writing human turns into
              input.
            </p>
            <p>
              We can’t stop that, but we can keep your words out of it. mdwn encrypts your writing in your browser
              before it leaves your device, so neither we nor any agent we could run can read it. Privacy here is not a
              promise in a policy; it is how the product is built.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-it-works-title" className="border-b border-ink">
      <div className="container-page grid lg:grid-cols-12">
        <div className="py-12 lg:col-span-5 lg:border-r lg:border-ink lg:py-16 lg:pr-10">
          <SectionHeading id="how-it-works-title" eyebrow="Getting started" title="Three steps, and not one password">
            The only things to keep safe are the ones only you should have.
          </SectionHeading>
        </div>
        <ol className="divide-y divide-line border-t border-ink lg:col-span-7 lg:border-t-0">
          {STEPS.map((step, index) => (
            <li key={step.title} className="grid grid-cols-[2rem_1fr] gap-4 py-8 lg:px-10">
              <span className="eyebrow pt-1 text-muted">0{index + 1}</span>
              <div>
                <h3 className="text-2xl font-light leading-tight tracking-tight">{step.title}</h3>
                <p className="mt-3 max-w-lg text-sm leading-relaxed text-ink-soft">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section aria-labelledby="features-title" className="border-b border-ink">
      <div className="container-page py-14 sm:py-20">
        <SectionHeading
          id="features-title"
          eyebrow="Features"
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
        <ul className="mt-12 border-t border-ink">
          {FEATURES.map(({ title, text, detail }) => (
            <li
              key={title}
              className="grid items-baseline gap-x-4 gap-y-2 border-b border-line py-5 md:grid-cols-[8rem_1fr_10rem] md:gap-x-6"
            >
              <h3 className="text-2xl font-light tracking-tight">{title}</h3>
              <p className="max-w-2xl text-sm leading-relaxed text-ink-soft">{text}</p>
              <p className="font-mono text-[11px] uppercase tracking-wide text-muted md:text-right">{detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Privacy() {
  return (
    <section id="privacy" aria-labelledby="privacy-title" className="border-b border-ink bg-sand">
      <div className="container-page py-14 sm:py-20">
        <SectionHeading id="privacy-title" eyebrow="Privacy" title="Your words never reach us readable">
          mdwn encrypts your writing on your device first. Our servers store ciphertext, not the keys to read it.
        </SectionHeading>
        <div className="mt-12 border-y border-ink py-7">
          <p className="eyebrow text-muted">The storage formula</p>
          <ol className="mt-5 flex flex-wrap items-center gap-3">
            {["Your Markdown", "Encryption in your browser", "Ciphertext on our servers"].map((step, index) => (
              <li key={step} className="flex max-w-full items-center gap-3">
                {index > 0 && <ArrowRightIcon className="text-muted" />}
                <span className="border border-ink px-4 py-3 text-xl font-light sm:text-2xl">{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <dl className="mt-8 grid gap-8 md:grid-cols-3 md:gap-10">
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
          ].map(({ title, text }) => (
            <div key={title}>
              <dt className="text-xl font-light">{title}</dt>
              <dd className="mt-3 text-sm leading-relaxed text-ink-soft">{text}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-10 max-w-3xl border-t border-line pt-5 text-sm leading-relaxed text-ink-soft">
          This protects stored content, not a compromised browser, malicious extension, or altered app code. Your
          browser and the code it runs remain part of the trust boundary.
        </p>
      </div>
    </section>
  );
}

function Publishing() {
  return (
    <section id="publishing" aria-labelledby="publishing-title" className="border-b border-ink">
      <div className="container-page grid items-start gap-12 py-14 sm:py-20 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-6">
          <SectionHeading
            id="publishing-title"
            eyebrow="Publishing"
            title="Publish one page. The key travels in the link."
          >
            When a File is ready for the world, publish it. Readers open a clean, read-only page that decrypts in their
            browser — no account needed.
          </SectionHeading>
          <ol className="mt-10 divide-y divide-line border-y border-line">
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
              <li key={step.title} className="flex gap-5 py-5">
                <span className="eyebrow w-6 shrink-0 pt-1 text-muted">0{index + 1}</span>
                <div>
                  <h3 className="text-xl font-light">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.text}</p>
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
    <section id="questions" aria-labelledby="questions-title" className="border-b border-ink">
      <div className="container-page grid gap-10 py-14 sm:py-20 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-4">
          <SectionHeading id="questions-title" eyebrow="Questions" title="Before you trust us with your words" />
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-ink-soft">
            Your writing is encrypted in your browser before upload. Here’s what that protects, and what stays in your
            hands.
          </p>
        </div>
        <div className="divide-y divide-line border-y border-line lg:col-span-8">
          {QUESTIONS.map((faq) => (
            <details key={faq.question} className="group">
              <summary className="flex items-baseline gap-3 py-5 sm:gap-5">
                <span className="flex-1 text-xl font-light leading-snug tracking-tight sm:text-2xl">
                  {faq.question}
                </span>
                <PlusIcon className="size-4 self-center text-muted transition-transform group-open:rotate-45" />
              </summary>
              <p className="max-w-3xl pb-6 text-[15px] leading-relaxed text-ink-soft">{faq.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCall() {
  return (
    <section className="bg-sand">
      <div className="container-page flex flex-col gap-8 py-14 sm:py-20 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <p className="eyebrow text-muted">Free, private, portable</p>
          <h2 className="mt-6 text-4xl font-light leading-[1.04] tracking-[-0.035em] text-balance sm:text-5xl">
            Your writing, sealed and yours to take anywhere.
          </h2>
          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-ink-soft">
            Create an account with a passkey. Export everything you own whenever you like.
          </p>
        </div>
        {/* Two equal columns: the actions share one width and one baseline. */}
        <div className="grid w-full shrink-0 gap-3 sm:w-[32rem] sm:grid-cols-2">
          <Link to="/sign-up" className={buttonClass("primary", "lg")}>
            Create your account <ArrowRightIcon />
          </Link>
          <Link to="/sign-in" className={buttonClass("secondary", "lg")}>
            I already have one
          </Link>
        </div>
      </div>
    </section>
  );
}
