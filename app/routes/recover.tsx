import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Link, useFetcher } from "react-router";

import { authGet, authPost } from "~/auth/client";
import type { AssertionStart, RegistrationStart } from "~/auth/contracts";
import { cx } from "~/ui/cx";
import { FolderIcon, KeyIcon } from "~/ui/icons";
import { FocusLayout, PageIntro, SkeletonLines } from "~/ui/page-layouts";
import { markSignedIn, markSignedOut } from "~/ui/session-presence";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/recover";

export function meta() {
  return [{ title: "Recover Account — mdwn" }];
}

/** SSR never reads or renders the Session; only the hydrated browser checks it. */
export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  try {
    return await authGet<{ restricted: boolean }>("/api/auth/recovery/status", request.signal);
  } catch {
    return { restricted: false };
  }
}

export function HydrateFallback() {
  return (
    <FocusLayout>
      <PageIntro eyebrow="Authentication recovery" title="Recover your Account">
        <p>Loading recovery…</p>
      </PageIntro>
      <SkeletonLines className="mt-10" />
    </FocusLayout>
  );
}

async function enrollAndSignIn(signal: AbortSignal): Promise<"recovered" | "started" | "passkey-added"> {
  let added = false;
  try {
    const start = await authPost<RegistrationStart>("/api/auth/recovery/options", {}, signal, "failed");
    const response = await startRegistration({ optionsJSON: start.options });
    await authPost<{ ok: true }>(
      "/api/auth/recovery/verify",
      {
        challengeId: start.challengeId,
        response,
      },
      signal,
      "failed",
    );
    added = true;
    // The registration revokes every Session, including this recovery Session.
    // A fresh Passkey assertion creates a normal Session without a device binding.
    const assertion = await authPost<AssertionStart>("/api/auth/sign-in/options", {}, signal, "failed");
    const verified = await startAuthentication({
      optionsJSON: { ...assertion.options, allowCredentials: [{ id: response.id, type: "public-key" }] },
    });
    await authPost<{ ok: true; bound: boolean }>(
      "/api/auth/sign-in/verify",
      {
        challengeId: assertion.challengeId,
        response: verified,
      },
      signal,
      "failed",
    );
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
      await authPost<{ ok: true }>(
        "/api/auth/recovery/start",
        {
          identifier: form.get("identifier"),
          code: form.get("code"),
        },
        request.signal,
        "failed",
      );
    } catch {
      if (request.signal.aborted) throw new Error("recovery aborted");
      return { state: "failed" } as const;
    }
  }
  const state = await enrollAndSignIn(request.signal);
  // A replacement passkey revokes every Session; only a completed sign-in has one.
  if (state === "recovered") markSignedIn();
  if (state === "passkey-added") markSignedOut();
  return { state } as const;
}

export default function Recover({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  const busy = fetcher.state !== "idle";
  const state = fetcher.data?.state;
  const canContinue = loaderData.restricted;
  return (
    <FocusLayout>
      <PageIntro eyebrow="Authentication recovery" title="Recover your Account">
        <p>
          If you have lost your passkeys, use your recovery identifier and one unused authentication recovery code to
          add a replacement passkey.
        </p>
      </PageIntro>
      <div className="mt-6 space-y-3 border-l-2 border-accent/40 pl-4 text-sm leading-relaxed text-ink-soft">
        <p>
          If you have lost every passkey and every code, your Account cannot be recovered. There is no support or
          operator override.
        </p>
        <p>
          A new passkey does not unlock your encrypted Files. This browser will still need separate device enrollment or
          your recovery phrase to regain private access.
        </p>
      </div>
      {state === "recovered" ? (
        <div role="status" className={cx(noticeClass("success"), "mt-8 animate-rise")}>
          <p>Your passkey is ready and you are signed in.</p>
          <Link to="/account/device-access" className={cx(buttonClass("primary", "sm"), "mt-4")}>
            <FolderIcon />
            Check private access
          </Link>
        </div>
      ) : state === "passkey-added" ? (
        <p role="status" className={cx(noticeClass("success"), "mt-8 animate-rise")}>
          Your replacement passkey was added and all former Sessions were revoked.{" "}
          <Link className={linkClass} to="/sign-in">
            Sign in with your new passkey
          </Link>
          .
        </p>
      ) : (
        <>
          {state === "failed" && (
            <p role="alert" className={cx(noticeClass("danger"), "mt-8")}>
              We could not begin recovery. Check your identifier and code or try again later.
            </p>
          )}
          {state === "started" && (
            <p role="status" className={cx(noticeClass("warning"), "mt-8")}>
              Your code has been used. Finish adding a passkey before this five-minute recovery Session expires. If it
              expires, you need another unused code.
            </p>
          )}
          {canContinue ? (
            <fetcher.Form method="post" className="mt-8">
              <button
                disabled={busy}
                type="submit"
                name="intent"
                value="continue"
                className={cx(buttonClass("primary", "lg"), "w-full")}
              >
                <KeyIcon />
                {busy ? "Adding passkey…" : "Continue adding a passkey"}
              </button>
            </fetcher.Form>
          ) : (
            <fetcher.Form method="post" className="mt-8 space-y-5 rounded-3xl bg-paper p-6 ring-1 ring-line sm:p-8">
              <label className={labelClass}>
                Recovery identifier
                <input
                  name="identifier"
                  required
                  autoComplete="off"
                  className={cx(fieldClass(), "mt-2 font-mono font-normal")}
                />
              </label>
              <label className={labelClass}>
                Unused recovery code
                <input
                  name="code"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  className={cx(fieldClass(), "mt-2 font-mono font-normal")}
                />
              </label>
              <button
                disabled={busy}
                type="submit"
                name="intent"
                value="start"
                className={cx(buttonClass("primary", "lg"), "w-full")}
              >
                {busy ? "Recovering…" : "Use recovery code"}
              </button>
            </fetcher.Form>
          )}
        </>
      )}
      <p className="mt-8 text-center text-sm text-ink-soft">
        Remembered your passkey?{" "}
        <Link to="/sign-in" className={linkClass}>
          Sign in
        </Link>
      </p>
    </FocusLayout>
  );
}
