import { useState } from "react";
import { Link, useFetcher } from "react-router";
import type { PrivateAccessState } from "~/shared/device/private-client";
import { listRelationships, readShareIdentifier, type Relationships } from "~/shared/sharing/relationships-client";
import { sharingLoadState } from "~/shared/sharing/sharing-errors";
import { runSharingIntent, type SharingOutcome } from "~/shared/sharing/sharing-intents";
import { sharedWithMe } from "~/shared/sharing/shared-with-me-cache";
import {
  InvitationItem,
  OutgoingShareItem,
  OwnedGrantItem,
  ReceivedGrantItem,
  SharingOutcomeNotice,
} from "~/sharing/sharing-management";
import { PrepareSecureAccess, useAutomaticPreparation } from "~/sharing/prepare-secure-access";
import type { ChromeHandle } from "~/ui/chrome";
import { cx } from "~/ui/cx";
import { CheckIcon, CopyIcon } from "~/ui/icons";
import { AccountLayout, PageIntro, SettingsSection, SkeletonLines } from "~/ui/page-layouts";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";
import type { Route } from "./+types/account-sharing";

export const handle: ChromeHandle = { chrome: "account" };

export function meta() {
  return [{ title: "Sharing — mdwn" }];
}

type SharingData =
  | { state: "ready"; shareIdentifier: string; relationships: Relationships }
  | { state: PrivateAccessState | "too-large" | "failed" };

/** Browser-only: no share identifier or relationship ever enters server HTML. */
export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<SharingData> {
  try {
    const [shareIdentifier, relationships] = await Promise.all([
      readShareIdentifier(request.signal),
      listRelationships(request.signal),
    ]);
    // The library sidebar can reuse this fresh read instead of listing again.
    sharedWithMe.prime({
      accountId: relationships.accountId,
      received: relationships.received,
      invitations: relationships.incoming.length,
    });
    return { state: "ready", shareIdentifier, relationships };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return { state: sharingLoadState(error) };
  }
}

/** One explicit intent per submission; native revalidation then reloads every list. */
export async function clientAction({ request }: Route.ClientActionArgs): Promise<SharingOutcome> {
  return runSharingIntent(await request.formData(), request.signal);
}

export function HydrateFallback() {
  return (
    <AccountLayout busy>
      <PageIntro eyebrow="Sharing" title="Sharing" />
      <p role="status" className="mt-6 text-sm text-muted">
        Loading sharing…
      </p>
      <SkeletonLines className="mt-6 max-w-xl" />
    </AccountLayout>
  );
}

function ShareIdentifier({ value }: { value: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  return (
    <SettingsSection
      className="mt-8"
      aria-label="Your share identifier"
      title="Your share identifier"
      description={
        <p>
          Give this to someone who wants to share a File or folder with you. It only addresses invitations: it is not
          your Public pseudonym, and it does not sign you in or reveal your content.
        </p>
      }
    >
      <label htmlFor="share-identifier" className={cx(labelClass, "mt-5")}>
        Share identifier
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          id="share-identifier"
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className={cx(fieldClass(), "min-w-0 flex-1 basis-72 font-mono text-sm")}
        />
        <button
          type="button"
          className={buttonClass("secondary")}
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => setCopied("copied"),
              () => setCopied("failed"),
            );
          }}
        >
          {copied === "copied" ? <CheckIcon /> : <CopyIcon />}
          {copied === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      {copied === "failed" && (
        <p role="alert" className="mt-2 text-sm text-warning">
          Copying is blocked in this browser. Select the identifier and copy it yourself.
        </p>
      )}
    </SettingsSection>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="mt-5 text-sm text-muted">{children}</p>;
}

export default function AccountSharing({ loaderData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof clientAction>();
  // Submitting, then revalidating: controls stay disabled until the lists reload.
  const busy = fetcher.state !== "idle";
  const ready = loaderData.state === "ready";
  const preparing = useAutomaticPreparation(ready ? loaderData.relationships.outgoing : [], ready);
  if (loaderData.state !== "ready")
    return (
      <AccountLayout>
        <PageIntro eyebrow="Sharing" title="Sharing" />
        <p role="alert" className={cx(noticeClass("warning"), "mt-8 max-w-xl")}>
          {loaderData.state === "signed-out"
            ? "Sign in to manage sharing."
            : loaderData.state === "too-large"
              ? "This Account has more sharing relationships than this page can list. Nothing was changed."
              : loaderData.state === "failed" || loaderData.state === "unavailable"
                ? "Sharing is unavailable right now. Refresh and try again."
                : "Use an enrolled device to manage sharing."}
        </p>
        <Link to="/account/device-access" className={cx(buttonClass("secondary", "sm"), "mt-6")}>
          Files access
        </Link>
      </AccountLayout>
    );
  const { incoming, received, outgoing, owned } = loaderData.relationships;
  const row = { Form: fetcher.Form, busy };
  return (
    <AccountLayout busy={busy}>
      <PageIntro eyebrow="Sharing" title="Sharing">
        <p>
          Review invitations, open what others share with you, and manage who can open your Files and folders. Names
          stay encrypted from recipients, so shared items appear as Shared File or Shared folder.
        </p>
      </PageIntro>
      {!busy && fetcher.data && <SharingOutcomeNotice outcome={fetcher.data} className="mt-6 max-w-2xl" />}
      <ShareIdentifier value={loaderData.shareIdentifier} />

      <SettingsSection
        className="mt-6"
        aria-label="Invitations"
        title="Invitations"
        description={<p>Accept to add the item to Shared with me in your library.</p>}
      >
        {incoming.length ? (
          <ul className="mt-3">
            {incoming.map((share) => (
              <InvitationItem key={share.shareId} share={share} {...row} />
            ))}
          </ul>
        ) : (
          <Empty>No pending invitations.</Empty>
        )}
      </SettingsSection>

      <SettingsSection className="mt-6" aria-label="Shared with you" title="Shared with you">
        {received.length ? (
          <ul className="mt-3">
            {received.map((grant) => (
              <ReceivedGrantItem key={grant.grantId} grant={grant} {...row} />
            ))}
          </ul>
        ) : (
          <Empty>Nothing is shared with you yet.</Empty>
        )}
      </SettingsSection>

      <SettingsSection
        className="mt-6"
        aria-label="Shared by you"
        title="Shared by you"
        description={
          <p>
            Revoking or changing a permission ends current access immediately. New edits under that item then wait until
            a{" "}
            <Link to="/account/key-rotations" className={linkClass}>
              secure access update
            </Link>{" "}
            finishes.
          </p>
        }
      >
        <h3 className="eyebrow mt-6 text-muted">Invitations you sent</h3>
        {preparing && (
          <p role="status" className="mt-2 text-sm text-muted">
            Preparing secure access for your newest pending invitations…
          </p>
        )}
        {outgoing.length ? (
          <ul className="mt-1">
            {outgoing.map((share) => (
              <OutgoingShareItem key={share.shareId} share={share} {...row}>
                <PrepareSecureAccess shareId={share.shareId} busy={busy} />
              </OutgoingShareItem>
            ))}
          </ul>
        ) : (
          <Empty>No pending invitations from you.</Empty>
        )}
        <h3 className="eyebrow mt-8 text-muted">Collaborators with access</h3>
        {owned.length ? (
          <ul className="mt-1">
            {owned.map((grant) => (
              <OwnedGrantItem key={`${grant.grantId}:${grant.revision}`} grant={grant} {...row} />
            ))}
          </ul>
        ) : (
          <Empty>No one has access to your Files or folders.</Empty>
        )}
      </SettingsSection>
    </AccountLayout>
  );
}
