import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Route } from "./+types/account-security";

type SessionSummary = {
  id: string;
  createdAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  refreshedAt: number | null;
  current: boolean;
};

type PasskeySummary = {
  id: string;
  createdAt: number;
  current: boolean;
};

type AssertionStart = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

type RegistrationStart = {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

type Screen = "loading" | "ready" | "signed-out" | "restricted" | "failed";

async function requestJson(path: string, body: object = {}): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function meta({}: Route.MetaArgs) {
  return [{ title: "Account security — mdwn" }];
}

export default function AccountSecurity() {
  const navigate = useNavigate();
  const [screen, setScreen] = useState<Screen>("loading");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadSecurity(): Promise<void> {
    try {
      const sessionsResponse = await fetch("/api/auth/sessions");
      if (sessionsResponse.status === 401) {
        setScreen("signed-out");
        return;
      }
      if (sessionsResponse.status === 403) {
        setScreen("restricted");
        return;
      }
      if (!sessionsResponse.ok) throw new Error("could not load sessions");

      const passkeysResponse = await fetch("/api/auth/passkeys");
      if (passkeysResponse.status === 401) {
        setScreen("signed-out");
        return;
      }
      if (passkeysResponse.status === 403) {
        setScreen("restricted");
        return;
      }
      if (!passkeysResponse.ok) throw new Error("could not load passkeys");

      const sessionsBody = (await sessionsResponse.json()) as { sessions: SessionSummary[] };
      const passkeysBody = (await passkeysResponse.json()) as { passkeys: PasskeySummary[] };
      setSessions(sessionsBody.sessions);
      setPasskeys(passkeysBody.passkeys);
      setScreen("ready");
    } catch {
      setScreen("failed");
    }
  }

  useEffect(() => {
    void loadSecurity();
  }, []);

  function handleSessionResponse(response: Response): boolean {
    if (response.status === 401) {
      navigate("/sign-in");
      return false;
    }
    if (response.status === 403) {
      setScreen("restricted");
      return false;
    }
    if (!response.ok) throw new Error("session action failed");
    return true;
  }

  async function mutate(path: string, body: object = {}): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      return handleSessionResponse(await requestJson(path, body));
    } catch {
      setMessage("We could not update your Sessions. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function completeFreshAssertion(): Promise<boolean> {
    const startResponse = await requestJson("/api/auth/passkeys/fresh/options");
    if (!handleSessionResponse(startResponse)) return false;
    const start = await startResponse.json() as AssertionStart;
    const response = await startAuthentication({ optionsJSON: start.options });
    const verifyResponse = await requestJson("/api/auth/passkeys/fresh/verify", {
      challengeId: start.challengeId,
      response,
    });
    if (!verifyResponse.ok) throw new Error("fresh assertion failed");
    return true;
  }

  async function addPasskey(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      if (!(await completeFreshAssertion())) return;
      const startResponse = await requestJson("/api/auth/passkeys/registration/options");
      if (!handleSessionResponse(startResponse)) return;
      const start = await startResponse.json() as RegistrationStart;
      const response = await startRegistration({ optionsJSON: start.options });
      const verifyResponse = await requestJson("/api/auth/passkeys/registration/verify", {
        challengeId: start.challengeId,
        response,
      });
      if (!verifyResponse.ok) throw new Error("passkey registration failed");
      setMessage("Passkey added.");
      await loadSecurity();
    } catch {
      setMessage("We could not update your Passkeys. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(passkey: PasskeySummary): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      if (!(await completeFreshAssertion())) return;
      const response = await requestJson("/api/auth/passkeys/remove", {
        credentialId: passkey.id,
      });
      if (!handleSessionResponse(response)) return;
      if (passkey.current) {
        navigate("/sign-in");
        return;
      }
      setMessage("Passkey removed.");
      await loadSecurity();
    } catch {
      setMessage("We could not update your Passkeys. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh(): Promise<void> {
    if (await mutate("/api/auth/session/refresh")) {
      setMessage("Session refreshed.");
      await loadSecurity();
    }
  }

  async function signOut(): Promise<void> {
    if (await mutate("/api/auth/sign-out")) navigate("/sign-in");
  }

  async function revoke(session: SessionSummary): Promise<void> {
    if (!(await mutate("/api/auth/sessions/revoke", { sessionId: session.id }))) return;
    if (session.current) {
      navigate("/sign-in");
      return;
    }
    setMessage("Session revoked.");
    await loadSecurity();
  }

  async function revokeAll(): Promise<void> {
    if (await mutate("/api/auth/sessions/revoke-all")) navigate("/sign-in");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 py-12">
      <Link className="text-sm text-stone-600 hover:underline" to="/">
        mdwn
      </Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Account security</h1>

      {screen === "loading" ? <p className="mt-4 text-stone-600">Loading account security…</p> : null}
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

      {screen === "ready" ? (
        <>
          <section className="mt-8">
            <h2 className="text-lg font-medium">Passkey management</h2>
            <p className="mt-2 text-sm text-stone-600">
              Confirm with a passkey before adding or removing a passkey.
            </p>
            <div className="mt-4">
              <button
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                disabled={busy}
                onClick={() => void addPasskey()}
                type="button"
              >
                Add passkey
              </button>
            </div>
            <ul className="mt-4 space-y-3">
              {passkeys.map((passkey) => (
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
                  <button
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium disabled:opacity-60"
                    disabled={busy || passkeys.length === 1}
                    onClick={() => void removePasskey(passkey)}
                    type="button"
                  >
                    {passkey.current ? "Remove current passkey" : "Remove passkey"}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-10 border-t border-stone-200 pt-8">
            <h2 className="text-lg font-medium">Session management</h2>
            <p className="mt-2 text-sm text-stone-600">
              Refresh extends the 30-day idle deadline without extending the 90-day maximum.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
                disabled={busy}
                onClick={() => void refresh()}
                type="button"
              >
                Refresh session
              </button>
              <button
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
                disabled={busy}
                onClick={() => void signOut()}
                type="button"
              >
                Sign out
              </button>
              <button
                className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                disabled={busy}
                onClick={() => void revokeAll()}
                type="button"
              >
                Sign out all sessions
              </button>
            </div>

            <ul className="mt-8 space-y-3">
              {sessions.map((session) => (
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
                  <button
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium disabled:opacity-60"
                    disabled={busy}
                    onClick={() => void revoke(session)}
                    type="button"
                  >
                    {session.current ? "Sign out this session" : "Revoke other session"}
                  </button>
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
