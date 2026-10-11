import { startRegistration } from "@simplewebauthn/browser";
import { useEffect } from "react";
import { Link, redirect, useFetcher } from "react-router";

import { authFailure, authGet, authPost } from "~/auth/client";
import { confirmFreshPasskey } from "~/auth/fresh-client";
import { prepareRecoveryCodeSet } from "~/shared/auth/recovery-codes";
import type { PasskeySummary, RegistrationStart, RevocationResult, SessionSummary } from "~/auth/contracts";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { DevicesIcon, KeyIcon, PlusIcon, RefreshIcon, UserIcon } from "~/ui/icons";
import { AccountLayout, PageIntro, SettingsSection, SkeletonLines } from "~/ui/page-layouts";
import { markSignedOut } from "~/ui/session-presence";
import { buttonClass, linkClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/account-security";

type SecurityData =
  | { state: "ready"; sessions: SessionSummary[]; passkeys: PasskeySummary[]; identifier: string }
  | { state: "signed-out" | "restricted" | "failed" };

type Operation = "passkeys" | "sessions" | "codes";

export const handle: ChromeHandle = { chrome: "account" };

export function meta() {
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
    return {
      state: "ready",
      sessions: sessions.sessions,
      passkeys: passkeys.passkeys,
      identifier: recovery.identifier,
    };
  } catch (error) {
    return { state: authFailure(error, request.signal) };
  }
}

export function HydrateFallback() {
  return (
    <AccountLayout busy>
      <PageIntro eyebrow="Account" title="Account security">
        <p>Loading account security…</p>
      </PageIntro>
      <SkeletonLines className="mt-10 max-w-xl" />
    </AccountLayout>
  );
}

async function addPasskey(signal: AbortSignal): Promise<void> {
  await confirmFreshPasskey(signal);
  const start = await authPost<RegistrationStart>("/api/auth/passkeys/registration/options", {}, signal, "failed");
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
  const operation: Operation =
    intent === "add-passkey" || intent === "remove-passkey"
      ? "passkeys"
      : intent === "rotate-codes"
        ? "codes"
        : "sessions";

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
          "/api/auth/passkeys/remove",
          { credentialId },
          request.signal,
          "failed",
        );
        if (result.signedOut) {
          markSignedOut();
          return redirect("/sign-in");
        }
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
        markSignedOut();
        return redirect("/sign-in");
      case "revoke": {
        const sessionId = form.get("sessionId");
        if (typeof sessionId !== "string" || !sessionId) break;
        const result = await authPost<RevocationResult>("/api/auth/sessions/revoke", { sessionId }, request.signal);
        if (result.signedOut) {
          markSignedOut();
          return redirect("/sign-in");
        }
        return { state: "success", message: "Session revoked." } as const;
      }
      case "revoke-all":
        await authPost<{ ok: true }>("/api/auth/sessions/revoke-all", {}, request.signal);
        markSignedOut();
        return redirect("/sign-in");
    }
  } catch (error) {
    return { state: authFailure(error, request.signal), operation } as const;
  }
  return { state: "failed", operation } as const;
}

export default function AccountSecurity({ loaderData, actionData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const reset = fetcher.reset;
  useEffect(() => {
    // A newer header navigation result must replace an earlier in-page result.
    // Later in-page submissions can then replace that result in turn.
    if (actionData) reset();
  }, [actionData, reset]);
  // The header submits a navigation Form so File draft blockers run before sign-out.
  // If that submission fails, explain it here just like an in-page fetcher failure.
  const result = fetcher.data ?? actionData;
  const busy = fetcher.state !== "idle";
  const screen = result?.state === "signed-out" || result?.state === "restricted" ? result.state : loaderData.state;
  const message =
    !busy && result?.state === "success"
      ? result.message
      : !busy && result?.state === "failed"
        ? result.operation === "passkeys"
          ? "We could not update your Passkeys. Try again."
          : result.operation === "codes"
            ? "We could not replace your recovery codes. Try again."
            : "We could not update your Sessions. Try again."
        : null;

  return (
    <AccountLayout>
      <PageIntro eyebrow="Account" title="Account security">
        <p>Passkeys, recovery codes and Sessions for this Account. Your Files’ keys are managed separately.</p>
      </PageIntro>

      {screen === "signed-out" ? (
        <p className={cx(noticeClass("info"), "mt-8 max-w-xl")}>
          Sign in to manage your Account.{" "}
          <Link className={linkClass} to="/sign-in">
            Sign in
          </Link>
        </p>
      ) : null}
      {screen === "restricted" ? (
        <p className={cx(noticeClass("warning"), "mt-8 max-w-xl")}>
          This recovery Session cannot manage normal Account security.
        </p>
      ) : null}
      {screen === "failed" ? (
        <p className={cx(noticeClass("danger"), "mt-8 max-w-xl")}>
          We could not load your Account security. Try again.
        </p>
      ) : null}

      {screen === "ready" && loaderData.state === "ready" ? (
        <div className="mt-10 space-y-6">
          <SettingsSection
            title="Passkey management"
            description={<p>Confirm with a passkey before adding or removing a passkey.</p>}
          >
            <fetcher.Form className="mt-5" method="post">
              <button
                className={buttonClass("primary", "sm")}
                disabled={busy}
                name="intent"
                value="add-passkey"
                type="submit"
              >
                <PlusIcon />
                Add passkey
              </button>
            </fetcher.Form>
            <ul className="mt-5 divide-y divide-line rounded-2xl ring-1 ring-line">
              {loaderData.passkeys.map((passkey) => (
                <li className="flex flex-wrap items-center justify-between gap-4 bg-white/50 p-4" key={passkey.id}>
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-full bg-cream text-accent ring-1 ring-line">
                      <KeyIcon />
                    </span>
                    <div>
                      <p className="font-medium">{passkey.current ? "Current passkey" : "Additional passkey"}</p>
                      <p className="mt-0.5 text-xs text-muted">Added {new Date(passkey.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                  <fetcher.Form method="post">
                    <input name="credentialId" type="hidden" value={passkey.id} />
                    <button
                      className={buttonClass("danger-quiet", "sm")}
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
          </SettingsSection>

          <SettingsSection
            title="Authentication recovery"
            description={
              <>
                <p>
                  Save this non-secret recovery identifier with your offline codes:{" "}
                  <span className="break-all rounded-md bg-cream px-1.5 py-0.5 font-mono text-ink">
                    {loaderData.identifier}
                  </span>
                </p>
                <p>
                  Replacing your codes invalidates every unused code in the previous set. Confirm with a passkey first.
                  Store the new codes safely: they will only be shown once.
                </p>
              </>
            }
          >
            <fetcher.Form method="post" className="mt-5">
              <button
                disabled={busy}
                name="intent"
                value="rotate-codes"
                type="submit"
                className={buttonClass("secondary", "sm")}
              >
                <RefreshIcon />
                Replace recovery codes
              </button>
            </fetcher.Form>
            {!busy && result?.state === "codes" && (
              <div role="status" className={cx(noticeClass("warning"), "mt-5")}>
                <p className="font-medium">Save these ten new one-time codes now. All previous codes are invalid.</p>
                <ol className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {result.codes.map((code, index) => (
                    <li className="break-all font-mono text-sm text-ink" key={code}>
                      <span className="mr-2 text-muted tabular-nums">{index + 1}.</span>
                      {code}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </SettingsSection>

          <div className="grid gap-6 md:grid-cols-2">
            <SettingsSection
              title="Encryption devices"
              description={
                <p>Manage the devices that can open your Files. Signing out a Session does not remove its device.</p>
              }
            >
              <Link className={cx(buttonClass("secondary", "sm"), "mt-5")} to="/account/devices">
                <DevicesIcon />
                View Encryption devices
              </Link>
            </SettingsSection>
            <SettingsSection
              title="Public pseudonym"
              description={
                <p>
                  The generated label shown on your Comments and credited Publications. You can change it at most once
                  every 30 days.
                </p>
              }
            >
              <Link className={cx(buttonClass("secondary", "sm"), "mt-5")} to="/account/pseudonym">
                <UserIcon />
                View Public pseudonym
              </Link>
            </SettingsSection>
          </div>

          <SettingsSection
            title="Session management"
            description={<p>Refresh extends the 30-day idle deadline without extending the 90-day maximum.</p>}
          >
            <fetcher.Form className="mt-5 flex flex-wrap gap-2" method="post">
              <button
                className={buttonClass("secondary", "sm")}
                disabled={busy}
                name="intent"
                value="refresh"
                type="submit"
              >
                Refresh session
              </button>
              <button
                className={buttonClass("secondary", "sm")}
                disabled={busy}
                name="intent"
                value="sign-out"
                type="submit"
              >
                Sign out
              </button>
              <button
                className={buttonClass("primary", "sm")}
                disabled={busy}
                name="intent"
                value="revoke-all"
                type="submit"
              >
                Sign out all sessions
              </button>
            </fetcher.Form>

            <ul className="mt-6 divide-y divide-line rounded-2xl ring-1 ring-line">
              {loaderData.sessions.map((session) => (
                <li className="flex flex-wrap items-center justify-between gap-4 bg-white/50 p-4" key={session.id}>
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      {session.current ? "Current session" : "Another session"}
                      {session.current && <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {session.refreshedAt ? "Refreshed" : "Created"}{" "}
                      {new Date(session.refreshedAt ?? session.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <fetcher.Form method="post">
                    <input name="sessionId" type="hidden" value={session.id} />
                    <button
                      className={buttonClass("danger-quiet", "sm")}
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
          </SettingsSection>

          {message ? (
            <p className={cx(noticeClass("info"), "max-w-xl")} role="status">
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </AccountLayout>
  );
}
