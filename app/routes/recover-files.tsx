import { Link, useFetcher } from "react-router";

import { forgetRecoveryPhrase, loadVaultRecovery, runVaultRecovery } from "~/recovery/ceremony-client";
import { useOwnedProvisioning } from "~/device/owned-provision-hook";

import type { Route } from "./+types/recover-files";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Recover your Files — mdwn" }];
}

export function clientLoader({ request }: Route.ClientLoaderArgs) {
  return loadVaultRecovery(request.signal);
}

export function HydrateFallback() {
  return <main className="mx-auto max-w-xl px-4 py-12"><h1 className="text-2xl font-semibold">Preparing recovery…</h1></main>;
}

export function clientAction({ request }: Route.ClientActionArgs) {
  return runVaultRecovery(request);
}

export default function RecoverFiles({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const needsRestoration = loaderData.restoring ||
    (fetcher.data?.state === "success" && fetcher.data.restoring);
  const restoring = useOwnedProvisioning(Boolean(needsRestoration));
  const busy = fetcher.state !== "idle";
  const phrase = fetcher.data?.state === "success" ? fetcher.data.phrase : loaderData.phrase;
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/" className="text-sm underline">mdwn</Link>
      <h1 className="mt-8 text-2xl font-semibold">Recover your Files</h1>
      {loaderData.state === "signed-out" ? (
        <p className="mt-4"><Link to="/sign-in" className="underline">Sign in with a passkey</Link> first.</p>
      ) : loaderData.state === "restricted" ? (
        <p className="mt-4">Finish replacing your passkey, then sign in with it before recovering your Files.</p>
      ) : loaderData.state === "failed" ? (
        <p className="mt-4">Recovery is unavailable. Please try again.</p>
      ) : (
        <>
          <p className="mt-4 text-stone-600">Confirm with a passkey and enter your current 24-word Files recovery phrase. Your phrase stays in this browser. Recovery replaces every previous Encryption device and signs out other Sessions.</p>
          {!phrase && <fetcher.Form method="post" className="mt-6 space-y-4">
            <label className="block text-sm font-medium" htmlFor="phrase">Current recovery phrase</label>
            <textarea id="phrase" name="phrase" required autoComplete="off" spellCheck={false}
              className="min-h-28 w-full rounded-md border border-stone-300 p-3 font-mono text-sm" />
            <button type="submit" disabled={busy}
              className="rounded-md bg-stone-900 px-4 py-2 text-white disabled:opacity-60">Recover Files</button>
          </fetcher.Form>}
          {busy && <p role="status" className="mt-4">Restoring your Files securely…</p>}
          {!busy && fetcher.data?.state === "failed" &&
            <p role="alert" className="mt-4 text-red-700">Recovery could not be completed. Start again with your current phrase.</p>}
          {!busy && fetcher.data?.state === "uncertain" &&
            <p role="alert" className="mt-4 text-amber-800">We could not confirm the result. <Link to="/sign-in" className="underline">Sign in with a passkey</Link> to check whether this device was activated before starting again.</p>}
          {phrase && <section className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4" role="status">
            <h2 className="font-semibold">Save your new recovery phrase</h2>
            <p className="mt-2 text-sm">Your previous phrase no longer works. Keep these 24 words offline.</p>
            <p className="mt-3 break-words font-mono">{phrase}</p>
            <button type="button" className="mt-4 underline" onClick={forgetRecoveryPhrase}>
              I saved this phrase
            </button>
          </section>}
          {fetcher.data?.state === "success" && restoring &&
            <p role="status" className="mt-4">Restoring your Files securely…</p>}
          {restoring && fetcher.data?.state !== "success" &&
            <p role="status" className="mt-4">Restoring your Files securely…</p>}
          {phrase && <Link to="/account/device-access" className="mt-4 inline-block underline">Open your Files</Link>}
        </>
      )}
    </main>
  );
}
