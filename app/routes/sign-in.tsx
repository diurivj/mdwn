import { startAuthentication } from "@simplewebauthn/browser";
import { Link, useFetcher } from "react-router";

import { authFailure, authPost } from "~/auth/client";
import type { AssertionStart } from "~/auth/contracts";

import type { Route } from "./+types/sign-in";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Sign in — mdwn" }];
}

/** WebAuthn must run in the browser; the resource actions retain server verification and cookies. */
export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  if (form.get("intent") !== "sign-in") return { state: "failed" } as const;

  try {
    const start = await authPost<AssertionStart>(
      "/api/auth/sign-in/options", {}, request.signal, "failed",
    );
    const response = await startAuthentication({ optionsJSON: start.options });
    await authPost<{ ok: true }>(
      "/api/auth/sign-in/verify",
      { challengeId: start.challengeId, response },
      request.signal,
      "failed",
    );
    return { state: "signed-in" } as const;
  } catch (error) {
    authFailure(error, request.signal);
    return { state: "failed" } as const;
  }
}

export default function SignIn() {
  const fetcher = useFetcher<typeof clientAction>();
  const working = fetcher.state !== "idle";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-3 text-stone-600">Use a passkey to sign in to your Account.</p>
      <fetcher.Form method="post">
        <button
          className="mt-8 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          disabled={working}
          name="intent"
          value="sign-in"
          type="submit"
        >
          {working ? "Checking your passkey…" : "Sign in with a passkey"}
        </button>
      </fetcher.Form>
      {!working && fetcher.data?.state === "signed-in" ? (
        <p className="mt-4 text-emerald-700">
          Signed in. <Link className="underline" to="/account/security">Manage Sessions</Link>
        </p>
      ) : null}
      {!working && fetcher.data?.state === "failed" ? (
        <p className="mt-4 text-red-700">We could not sign you in. Try again.</p>
      ) : null}
    </main>
  );
}
