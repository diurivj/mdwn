import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/sign-in";

type SignInStart = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error("authentication failed");
  return response.json() as Promise<T>;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: "Sign in — mdwn" }];
}

export default function SignIn() {
  const [status, setStatus] = useState<"idle" | "working" | "signed-in" | "failed">("idle");

  async function signIn(): Promise<void> {
    setStatus("working");
    try {
      const start = await readJson<SignInStart>(
        await fetch("/api/auth/sign-in/options", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      const response = await startAuthentication({ optionsJSON: start.options });
      await readJson(
        await fetch("/api/auth/sign-in/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId: start.challengeId, response }),
        }),
      );
      setStatus("signed-in");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-3 text-stone-600">Use a passkey to sign in to your Account.</p>
      <button
        className="mt-8 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        disabled={status === "working"}
        onClick={() => void signIn()}
        type="button"
      >
        {status === "working" ? "Checking your passkey…" : "Sign in with a passkey"}
      </button>
      {status === "signed-in" ? (
        <p className="mt-4 text-emerald-700">
          Signed in. <Link className="underline" to="/account/security">Manage Sessions</Link>
        </p>
      ) : null}
      {status === "failed" ? (
        <p className="mt-4 text-red-700">We could not sign you in. Try again.</p>
      ) : null}
    </main>
  );
}
