import { startRegistration } from "@simplewebauthn/browser";
import { Link, redirect, useFetcher } from "react-router";

import { authFailure, authGet, authPost } from "~/auth/client";
import { confirmFreshPasskey } from "~/auth/fresh-client";
import { prepareRecoveryCodeSet } from "~/shared/auth/recovery-codes";
import type {
  PasskeySummary,
  RegistrationStart,
  RevocationResult,
  SessionSummary,
} from "~/auth/contracts";

import type { Route } from "./+types/account-security";

type SecurityData =
  | { state: "ready"; sessions: SessionSummary[]; passkeys: PasskeySummary[]; identifier: string }
  | { state: "signed-out" | "restricted" | "failed" };

type Operation = "passkeys" | "sessions" | "codes";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Account security — mdwn" }];
}

/** No server loader: the shell is SSR'd, but Account data only reaches the browser. */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<SecurityData> {
  try {
    const [sessions, passkeys, recovery] = await Promise.all([
      authGet<{ sessions: SessionSummary[] }>("/api/auth/sessions", request.signal),
      authGet<{ passkeys: PasskeySummary[] }>("/api/auth/passkeys", request.signal),
      authGet<{ identifier: string }>("/api/auth/recovery/identifier", request.signal),
    ]);
    return { state: "ready", sessions: sessions.sessions, passkeys: passkeys.passkeys, identifier: recovery.identifier };
  } catch (error) {
    return { state: authFailure(error, request.signal) };
  }
}

export function HydrateFallback() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-12">
      <Link className="text-sm text-stone-600 hover:underline" to="/">mdwn</Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Account security</h1>
      <p className="mt-4 text-stone-600">Loading account security…</p>
    </main>
  );
}

async function addPasskey(signal: AbortSignal): Promise<void> {
  await confirmFreshPasskey(signal);
  const start = await authPost<RegistrationStart>(
    "/api/auth/passkeys/registration/options", {}, signal, "failed",
  );
  const response = await startRegistration({ optionsJSON: start.options });
  await authPost<{ ok: true }>(
    "/api/auth/passkeys/registration/verify",
    { challengeId: start.challengeId, response },
    signal,
    "failed",
  );
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  const operation: Operation = intent === "add-passkey" || intent === "remove-passkey"
    ? "passkeys"
    : intent === "rotate-codes" ? "codes" : "sessions";

  try {
    switch (intent) {
      case "add-passkey":
        await addPasskey(request.signal);
        return { state: "success", message: "Passkey added." } as const;
      case "remove-passkey": {
        const credentialId = form.get("credentialId");
        if (typeof credentialId !== "string" || !credentialId) break;
        await confirmFreshPasskey(request.signal);
        const result = await authPost<RevocationResult>(
          "/api/auth/passkeys/remove", { credentialId }, request.signal, "failed",
        );
        if (result.signedOut) return redirect("/sign-in");
        return { state: "success", message: "Passkey removed." } as const;
      }
      case "rotate-codes": {
        await confirmFreshPasskey(request.signal);
        const { codes, hashes } = await prepareRecoveryCodeSet();
        await authPost<{ ok: true }>("/api/auth/recovery/rotate", { hashes }, request.signal, "failed");
        return { state: "codes", codes } as const;
      }
      case "refresh":
        await authPost<{ ok: true }>("/api/auth/session/refresh", {}, request.signal);
        return { state: "success", message: "Session refreshed." } as const;
      case "sign-out":
        await authPost<{ ok: true }>("/api/auth/sign-out", {}, request.signal);
        return redirect("/sign-in");
      case "revoke": {
        const sessionId = form.get("sessionId");
        if (typeof sessionId !== "string" || !sessionId) break;
        const result = await authPost<RevocationResult>(
          "/api/auth/sessions/revoke", { sessionId }, request.signal,
        );
        if (result.signedOut) return redirect("/sign-in");
        return { state: "success", message: "Session revoked." } as const;
      }
      case "revoke-all":
        await authPost<{ ok: true }>("/api/auth/sessions/revoke-all", {}, request.signal);
        return redirect("/sign-in");
    }
  } catch (error) {
    return { state: authFailure(error, request.signal), operation } as const;
  }
  return { state: "failed", operation } as const;
}

export default function AccountSecurity({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  const screen = fetcher.data?.state === "signed-out" || fetcher.data?.state === "restricted"
    ? fetcher.data.state
    : loaderData.state;
  const message = !busy && fetcher.data?.state === "success"
    ? fetcher.data.message
    : !busy && fetcher.data?.state === "failed"
      ? fetcher.data.operation === "passkeys"
        ? "We could not update your Passkeys. Try again."
        : fetcher.data.operation === "codes"
          ? "We could not replace your recovery codes. Try again."
          : "We could not update your Sessions. Try again."
      : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-12">
      <Link className="text-sm text-stone-600 hover:underline" to="/">mdwn</Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Account security</h1>

      {screen === "signed-out" ? (
        <p className="mt-4 text-stone-600">
          Sign in to manage your Account. <Link className="underline" to="/sign-in">Sign in</Link>
        </p>
      ) : null}
      {screen === "restricted" ? (
        <p className="mt-4 text-stone-600">
          This recovery Session cannot manage normal Account security.
        </p>
      ) : null}
      {screen === "failed" ? (
        <p className="mt-4 text-red-700">We could not load your Account security. Try again.</p>
      ) : null}

      {screen === "ready" && loaderData.state === "ready" ? (
        <>
          <section className="mt-8">
            <h2 className="text-lg font-medium">Passkey management</h2>
            <p className="mt-2 text-sm text-stone-600">
              Confirm with a passkey before adding or removing a passkey.
            </p>
            <fetcher.Form className="mt-4" method="post">
              <button
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                disabled={busy}
                name="intent"
                value="add-passkey"
                type="submit"
              >
                Add passkey
              </button>
            </fetcher.Form>
            <ul className="mt-4 space-y-3">
              {loaderData.passkeys.map((passkey) => (
                <li
                  className="flex items-center justify-between gap-4 rounded-md border border-stone-200 bg-white p-4"
                  key={passkey.id}
                >
                  <div>
                    <p className="font-medium">{passkey.current ? "Current passkey" : "Additional passkey"}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      Added {new Date(passkey.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <fetcher.Form method="post">
                    <input name="credentialId" type="hidden" value={passkey.id} />
                    <button
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium disabled:opacity-60"
                      disabled={busy || loaderData.passkeys.length === 1}
                      name="intent"
                      value="remove-passkey"
                      type="submit"
                    >
                      {passkey.current ? "Remove current passkey" : "Remove passkey"}
                    </button>
                  </fetcher.Form>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-10 border-t border-stone-200 pt-8">
            <h2 className="text-lg font-medium">Authentication recovery</h2>
            <p className="mt-2 text-sm text-stone-600">Save this non-secret recovery identifier with your offline codes: <span className="break-all font-mono">{loaderData.identifier}</span></p>
            <p className="mt-2 text-sm text-stone-600">Replacing your codes invalidates every unused code in the previous set. Confirm with a passkey first. Store the new codes safely: they will only be shown once.</p>
            <fetcher.Form method="post" className="mt-4">
              <button disabled={busy} name="intent" value="rotate-codes" type="submit" className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-60">Replace recovery codes</button>
            </fetcher.Form>
            {!busy && fetcher.data?.state === "codes" && (
              <div role="status" className="mt-4 rounded-md border p-4">
                <p>Save these ten new one-time codes now. All previous codes are invalid.</p>
                <ol className="mt-3 space-y-1">
                  {fetcher.data.codes.map((code, index) => <li className="break-all font-mono text-sm" key={index}>{index + 1}. {code}</li>)}
                </ol>
              </div>
            )}
          </section>

          <section className="mt-10 border-t border-stone-200 pt-8">
            <h2 className="text-lg font-medium">Encryption devices</h2>
            <p className="mt-2 text-sm text-stone-600">Manage the devices that can open your Files. Signing out a Session does not remove its device.</p>
            <Link className="mt-3 inline-block underline" to="/account/devices">View Encryption devices</Link>
          </section>

          <section className="mt-10 border-t border-stone-200 pt-8">
            <h2 className="text-lg font-medium">Public pseudonym</h2>
            <p className="mt-2 text-sm text-stone-600">The generated label shown on your Comments and credited Publications. You can change it at most once every 30 days.</p>
            <Link className="mt-3 inline-block underline" to="/account/pseudonym">View Public pseudonym</Link>
          </section>

          <section className="mt-10 border-t border-stone-200 pt-8">
            <h2 className="text-lg font-medium">Session management</h2>
            <p className="mt-2 text-sm text-stone-600">
              Refresh extends the 30-day idle deadline without extending the 90-day maximum.
            </p>
            <fetcher.Form className="mt-4 flex flex-wrap gap-3" method="post">
              <button
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
                disabled={busy}
                name="intent"
                value="refresh"
                type="submit"
              >
                Refresh session
              </button>
              <button
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
                disabled={busy}
                name="intent"
                value="sign-out"
                type="submit"
              >
                Sign out
              </button>
              <button
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                disabled={busy}
                name="intent"
                value="revoke-all"
                type="submit"
              >
                Sign out all sessions
              </button>
            </fetcher.Form>

            <ul className="mt-8 space-y-3">
              {loaderData.sessions.map((session) => (
                <li
                  className="flex items-center justify-between gap-4 rounded-md border border-stone-200 bg-white p-4"
                  key={session.id}
                >
                  <div>
                    <p className="font-medium">
                      {session.current ? "Current session" : "Another session"}
                    </p>
                    <p className="mt-1 text-xs text-stone-500">
                      {session.refreshedAt ? "Refreshed" : "Created"} {new Date(session.refreshedAt ?? session.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <fetcher.Form method="post">
                    <input name="sessionId" type="hidden" value={session.id} />
                    <button
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium disabled:opacity-60"
                      disabled={busy}
                      name="intent"
                      value="revoke"
                      type="submit"
                    >
                      {session.current ? "Sign out this session" : "Revoke other session"}
                    </button>
                  </fetcher.Form>
                </li>
              ))}
            </ul>
          </section>

          {message ? <p className="mt-4 text-sm text-stone-700" role="status">{message}</p> : null}
        </>
      ) : null}
    </main>
  );
}
