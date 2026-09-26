import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Link, useFetcher } from "react-router";

import { authGet, authPost } from "~/auth/client";
import type { AssertionStart, RegistrationStart } from "~/auth/contracts";

import type { Route } from "./+types/recover";

export function meta() { return [{ title: "Recover Account — mdwn" }]; }

/** SSR never reads or renders the Session; only the hydrated browser checks it. */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  try {
    return await authGet<{ restricted: boolean }>("/api/auth/recovery/status", request.signal);
  } catch { return { restricted: false }; }
}

export function HydrateFallback() {
  return <main className="mx-auto max-w-lg px-4 py-12"><h1 className="text-3xl font-semibold">Recover your Account</h1><p className="mt-4">Loading recovery…</p></main>;
}

async function enrollAndSignIn(signal: AbortSignal): Promise<"recovered" | "started" | "passkey-added"> {
  let added = false;
  try {
    const start = await authPost<RegistrationStart>("/api/auth/recovery/options", {}, signal, "failed");
    const response = await startRegistration({ optionsJSON: start.options });
    await authPost<{ ok: true }>("/api/auth/recovery/verify", {
      challengeId: start.challengeId, response,
    }, signal, "failed");
    added = true;
    // The registration revokes every Session, including this recovery Session.
    // A fresh Passkey assertion creates a normal Session without a device binding.
    const assertion = await authPost<AssertionStart>("/api/auth/sign-in/options", {}, signal, "failed");
    const verified = await startAuthentication({
      optionsJSON: { ...assertion.options, allowCredentials: [{ id: response.id, type: "public-key" }] },
    });
    await authPost<{ ok: true; bound: boolean }>("/api/auth/sign-in/verify", {
      challengeId: assertion.challengeId, response: verified,
    }, signal, "failed");
    return "recovered";
  } catch {
    if (signal.aborted) throw new Error("recovery aborted");
    return added ? "passkey-added" : "started";
  }
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "start" && intent !== "continue") return { state: "failed" } as const;
  if (intent === "start") {
    try {
      await authPost<{ ok: true }>("/api/auth/recovery/start", {
        identifier: form.get("identifier"), code: form.get("code"),
      }, request.signal, "failed");
    } catch {
      if (request.signal.aborted) throw new Error("recovery aborted");
      return { state: "failed" } as const;
    }
  }
  return { state: await enrollAndSignIn(request.signal) } as const;
}

export default function Recover({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  const state = fetcher.data?.state;
  const canContinue = loaderData.restricted || state === "started";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-4 py-12">
      <Link to="/sign-in" className="text-sm underline">Sign in</Link>
      <h1 className="mt-8 text-3xl font-semibold">Recover your Account</h1>
      <p className="mt-3 text-stone-600">If you have lost your passkeys, use your recovery identifier and one unused authentication recovery code to add a replacement passkey.</p>
      <p className="mt-3 text-stone-600">If you have lost every passkey and every code, your Account cannot be recovered. There is no support or operator override.</p>
      <p className="mt-3 text-stone-600">A new passkey does not unlock your encrypted Files. This browser will still need separate device enrollment or your Vault recovery phrase to regain private access.</p>
      {state === "recovered" ? (
        <p role="status" className="mt-6">Your passkey is ready and you are signed in. <Link className="underline" to="/account/device-access">Check private access</Link>.</p>
      ) : state === "passkey-added" ? (
        <p role="status" className="mt-6">Your replacement passkey was added and all former Sessions were revoked. <Link className="underline" to="/sign-in">Sign in with your new passkey</Link>.</p>
      ) : (
        <>
          {state === "failed" && <p role="alert" className="mt-6 text-red-700">We could not begin recovery. Check your identifier and code or try again later.</p>}
          {state === "started" && <p role="status" className="mt-6 text-amber-800">Your code has been used. Finish adding a passkey before this five-minute recovery Session expires. If it expires, you need another unused code.</p>}
          {canContinue ? (
            <fetcher.Form method="post" className="mt-6">
              <button disabled={busy} type="submit" name="intent" value="continue" className="rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60">
                {busy ? "Adding passkey…" : "Continue adding a passkey"}
              </button>
            </fetcher.Form>
          ) : (
            <fetcher.Form method="post" className="mt-6 flex flex-col gap-4">
              <label>Recovery identifier
                <input name="identifier" required autoComplete="off" className="mt-1 block w-full rounded border p-2 font-mono" />
              </label>
              <label>Unused recovery code
                <input name="code" required autoComplete="off" spellCheck={false} className="mt-1 block w-full rounded border p-2 font-mono" />
              </label>
              <button disabled={busy} type="submit" name="intent" value="start" className="self-start rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60">
                {busy ? "Recovering…" : "Use recovery code"}
              </button>
            </fetcher.Form>
          )}
        </>
      )}
    </main>
  );
}
