import { Link } from "react-router";

import { getEnv } from "~/context/env";
import { ping } from "~/db/client.server";

import type { Route } from "./+types/home";

/**
 * Application shell loader. Returns only non-sensitive data: the environment
 * name and D1 connectivity status. No private plaintext, cookies, or secrets.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const dbConnected = await ping(env.DB);
  return { appEnv: env.APP_ENV, dbConnected };
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "mdwn — private markdown vault" },
    {
      name: "description",
      content:
        "mdwn is a private markdown vault: write, browse, share, and selectively publish Markdown.",
    },
  ];
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4">
      <header className="flex items-center justify-between border-b border-stone-200 py-4">
        <span className="text-lg font-semibold tracking-tight">mdwn</span>
        <nav className="flex items-center gap-3 text-sm text-stone-500">
          <span>Files</span>
          <Link className="text-stone-700 hover:underline" to="/sign-in">
            Sign in
          </Link>
        </nav>
      </header>

      <main className="flex flex-1 flex-col justify-center py-16">
        <h1 className="text-3xl font-semibold tracking-tight">
          A private markdown vault.
        </h1>
        <p className="mt-3 max-w-xl text-stone-600">
          mdwn is an end-to-end-encrypted place to write and browse Markdown,
          share selectively with other accounts, and publish individual files.
          This is the application shell — the Files experience, passkeys,
          sharing, and publishing arrive in later milestones.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Badge label="Environment" value={loaderData.appEnv} tone="stone" />
          <Badge
            label="Database (D1)"
            value={loaderData.dbConnected ? "connected" : "unavailable"}
            tone={loaderData.dbConnected ? "green" : "red"}
          />
          <Badge label="Encryption" value="browser-only (planned)" tone="stone" />
        </div>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 py-4 text-xs text-stone-500">
        <p>
          No tracking, no ads, no monetization. Private content is decrypted only
          in your browser.
        </p>
        <Link className="text-stone-700 hover:underline" to="/support">
          Support mdwn
        </Link>
      </footer>
    </div>
  );
}

function Badge({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "red" | "stone";
}) {
  const tones = {
    green: "border-emerald-300 bg-emerald-50 text-emerald-800",
    red: "border-red-300 bg-red-50 text-red-800",
    stone: "border-stone-300 bg-stone-50 text-stone-700",
  };
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${tones[tone]}`}
    >
      <span className="text-stone-500">{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  );
}
