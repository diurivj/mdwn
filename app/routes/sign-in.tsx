import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { Link, redirect, useFetcher } from "react-router";

import { authFailure, authGet, authPost } from "~/auth/client";
import type { AssertionStart } from "~/auth/contracts";
import { hasDeviceBoundSession } from "~/auth/session.server";
import { getEnv } from "~/context/env";
import { signDeviceProof, type DeviceProof } from "~/shared/device/proof";
import { getDevice, updateRegistryEpoch } from "~/shared/device/store";
import { cx } from "~/ui/cx";
import { KeyIcon } from "~/ui/icons";
import { FocusLayout, PageIntro } from "~/ui/page-layouts";
import { markSignedIn } from "~/ui/session-presence";
import { buttonClass, linkClass, noticeClass } from "~/ui/styles";

import type { Route } from "./+types/sign-in";

export function meta() {
  return [{ title: "Sign in — mdwn" }];
}

/**
 * Reads only whether the Session is already device-bound, to send it to its
 * library; it renders nothing Account-specific. A Session check that fails
 * still shows the sign-in page.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  if (await hasDeviceBoundSession(request, getEnv(context)).catch(() => false)) return redirect("/files");
  return null;
}

/** WebAuthn must run in the browser; the resource actions retain server verification and cookies. */
export async function clientAction({ request }: Route.ClientActionArgs) {
  const form = await request.formData();
  if (form.get("intent") !== "sign-in") return { state: "failed" } as const;

  try {
    const start = await authPost<AssertionStart>("/api/auth/sign-in/options", {}, request.signal, "failed");
    const response = await startAuthentication({ optionsJSON: start.options });
    const submission = { challengeId: start.challengeId, response };
    let deviceProof: DeviceProof | undefined;
    const userHandle = response.response.userHandle;
    if (start.sessionBinding && userHandle) {
      try {
        const accountId = atob(userHandle.replaceAll("-", "+").replaceAll("_", "/"));
        const device = await getDevice(accountId);
        if (device) {
          deviceProof = await signDeviceProof(device.assertionKeyPair.privateKey, {
            sessionBinding: start.sessionBinding,
            deviceId: device.deviceId,
            registryEpoch: device.registryEpoch,
            method: "POST",
            url: new URL("/api/auth/sign-in/verify", location.origin).href,
            body: JSON.stringify(submission),
          });
        }
      } catch {
        // Missing/evicted/unreadable keys produce an unprovisioned Session, never a substitute device.
      }
    }
    const result = await authPost<{ ok: true; bound: boolean }>(
      "/api/auth/sign-in/verify",
      { ...submission, deviceProof },
      request.signal,
      "failed",
    );
    markSignedIn();
    if (result.bound) return redirect("/files");
    // The Passkey created an unprovisioned Session. If the local device only
    // had a stale epoch, refresh its cached authority; binding still needs
    // a *new* Passkey sign-in, never an upgrade of this Session in place.
    try {
      const state = await authGet<{ accountId: string; registryEpoch: number | null }>(
        "/api/device/state",
        request.signal,
      );
      const saved = await getDevice(state.accountId);
      if (saved && state.registryEpoch !== null && state.registryEpoch > saved.registryEpoch) {
        const current = await authGet<{
          accountId: string;
          registryEpoch: number | null;
          candidateActive: boolean;
        }>(`/api/device/state?candidateDeviceId=${encodeURIComponent(saved.deviceId)}`, request.signal);
        if (
          current.accountId === state.accountId &&
          current.registryEpoch === state.registryEpoch &&
          current.candidateActive
        ) {
          await updateRegistryEpoch(state.accountId, state.registryEpoch);
          return { state: "registry-refreshed" } as const;
        }
      }
    } catch {
      if (request.signal.aborted) throw new Error("sign-in aborted");
      // Revoked/missing/unreadable keys remain unprovisioned.
    }
    // Without an active Encryption device here, the library hands over to device access.
    return redirect("/files");
  } catch (error) {
    authFailure(error, request.signal);
    return { state: "failed" } as const;
  }
}

export default function SignIn() {
  const fetcher = useFetcher<typeof clientAction>();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  const working = fetcher.state !== "idle";
  const outcome = working ? undefined : fetcher.data?.state;

  return (
    <FocusLayout>
      <PageIntro eyebrow="Welcome back" title="Sign in">
        <p>Use a passkey to sign in to your Account.</p>
      </PageIntro>
      <div className="mt-8 border border-line bg-cream p-6 sm:p-8">
        <fetcher.Form method="post">
          <button
            className={cx(buttonClass("primary", "lg"), "w-full")}
            disabled={!hydrated || working}
            name="intent"
            value="sign-in"
            type="submit"
          >
            <KeyIcon />
            {working ? "Checking your passkey…" : "Sign in with a passkey"}
          </button>
        </fetcher.Form>
        <p className="mt-4 text-center text-xs leading-relaxed text-muted">
          Your browser or password manager asks you to confirm. There is no password to type.
        </p>
      </div>
      {outcome === "registry-refreshed" ? (
        <div className={cx(noticeClass("warning"), "mt-6 animate-rise")}>
          <p>
            <span className="font-medium">Signed in.</span>
            <span className="mt-1 block">
              Device registry changed. Sign in again with your passkey to check this device's current authority.
            </span>
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className={buttonClass("primary", "sm")} to="/account/device-access">
              Check private access
            </Link>
            <Link className={buttonClass("ghost", "sm")} to="/account/security">
              Manage Sessions
            </Link>
          </div>
        </div>
      ) : null}
      {outcome === "failed" ? (
        <p className={cx(noticeClass("danger"), "mt-6")}>We could not sign you in. Try again.</p>
      ) : null}
      <div className="mt-10 space-y-2 border-t border-line pt-6 text-sm text-ink-soft">
        <p>
          New to mdwn?{" "}
          <Link className={linkClass} to="/sign-up">
            Create an account
          </Link>
          .
        </p>
        <p>
          Lost all your passkeys?{" "}
          <Link className={linkClass} to="/recover">
            Use an authentication recovery code
          </Link>
          .
        </p>
      </div>
    </FocusLayout>
  );
}
