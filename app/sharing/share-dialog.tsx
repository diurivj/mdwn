import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { clientAction as sharingAction, clientLoader as sharingLoader } from "~/routes/account-sharing";
import { inviteShare, type RelationshipPermission } from "~/shared/sharing/relationships-client";
import { prepareShare, type SharePreparationProgress } from "~/shared/sharing/share-staging-client";
import { type SharingFailure, sharingFailure } from "~/shared/sharing/sharing-errors";
import type { DirectoryListing, RootAccess, TreeKind } from "~/shared/tree/client";
import { convertFileCapability } from "~/shared/tree/file-capability-client";
import { type Crumb, type FilesSnapshot, kindName, sharedTargetPath } from "~/tree/navigation-client";
import { cx } from "~/ui/cx";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";
import {
  PreparationFailure,
  PrepareSecureAccess,
  progressLabel,
  SecureAccessUpdateRequired,
} from "./prepare-secure-access";
import { OutgoingShareItem, OwnedGrantItem, permissionLabel, SharingOutcomeNotice } from "./sharing-management";

/**
 * The workspace **Share** dialog for one owned File or folder. It invites by
 * the recipient's exact share identifier, then prepares secure access from
 * this device. Existing invitations and Collaborators for this target reuse
 * the Sharing page's rows, loader and intents; nothing here is server-rendered.
 * The server is the authority for write seals and duplicate invitations.
 */

type Target = {
  access: RootAccess;
  nodeId: string;
  kind: TreeKind;
  /** The current File document, when the target is a File. */
  file: FilesSnapshot["file"];
  /** The File's parent listing and key, used only to convert a legacy File. */
  parent: { listing: DirectoryListing; key: Uint8Array } | null;
  /** The target's ancestor folders in this Owner's library, root first. */
  ancestors: readonly Crumb[];
};

type InviteFailure = SharingFailure | "self";
type Outcome =
  | { kind: "working"; step: "converting" | "inviting" }
  | { kind: "preparing"; progress: SharePreparationProgress | null }
  | { kind: "shared" }
  | { kind: "prepare-failed"; failure: SharingFailure }
  | { kind: "failed"; failure: InviteFailure };

const PERMISSIONS: readonly RelationshipPermission[] = ["read_only", "read_write"];

function InviteFailureMessage({ failure }: { failure: InviteFailure }) {
  switch (failure) {
    case "not-found":
      return <>No Account has that share identifier. Check it with the person you want to share with.</>;
    case "self":
      return <>That is your own share identifier. You can’t share with yourself.</>;
    case "already-shared":
      return <>That Account already has an invitation or access for this item.</>;
    case "sealed":
      return <SecureAccessUpdateRequired />;
    case "changed":
      return <>This sharing changed while you worked. Try again.</>;
    case "access":
      return <>Use an enrolled device with a current Session to share.</>;
    case "recovery":
      return <>Confirm your saved recovery phrase and codes before sharing.</>;
    default:
      return <>Sharing is unavailable right now. Try again.</>;
  }
}

export function ShareDialog({
  target,
  onClose,
  onConverted,
}: {
  target: Target;
  onClose: () => void;
  /** A legacy File conversion committed (or may have): refresh the Files snapshot. */
  onConverted: () => void;
}) {
  const lists = useFetcher<typeof sharingLoader>();
  const intents = useFetcher<typeof sharingAction>();
  const [identifier, setIdentifier] = useState("");
  const [permission, setPermission] = useState<RelationshipPermission>("read_only");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);

  const { load: loadLists } = lists;
  useEffect(() => {
    void loadLists("/account/sharing");
  }, [loadLists]);
  // A row intent does not reload Files; this dialog re-reads only its lists.
  const intentDone = intents.state === "idle" && intents.data;
  useEffect(() => {
    if (intentDone) void loadLists("/account/sharing");
  }, [intentDone, loadLists]);

  const ready = lists.data?.state === "ready" ? lists.data : null;
  const outgoing = ready?.relationships.outgoing.filter((share) => share.targetId === target.nodeId) ?? [];
  const owned = ready?.relationships.owned.filter((grant) => grant.targetId === target.nodeId) ?? [];
  // Access that reaches this item through a shared parent folder is managed on that folder.
  const inherited = target.ancestors
    .map((folder) => ({
      folder,
      collaborators: ready?.relationships.owned.filter((grant) => grant.targetId === folder.id).length ?? 0,
      invitations: ready?.relationships.outgoing.filter((share) => share.targetId === folder.id).length ?? 0,
    }))
    .filter((item) => item.collaborators + item.invitations > 0);
  const working = outcome?.kind === "working" || outcome?.kind === "preparing";
  const rowsBusy = intents.state !== "idle" || lists.state !== "idle" || working;
  const label = kindName(target.kind);

  async function share() {
    const recipient = identifier.trim();
    if (!recipient || working) return;
    if (ready && recipient === ready.shareIdentifier) return setOutcome({ kind: "failed", failure: "self" });
    if ([...outgoing, ...owned].some((row) => row.recipientShareId === recipient))
      return setOutcome({ kind: "failed", failure: "already-shared" });
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const { signal } = controller;
    let conversion: "none" | "started" | "committed" = "none";
    let shareId: string;
    try {
      if (target.kind === "file" && target.file && !target.file.capability) {
        // A legacy File needs its own capability before anyone else can hold it.
        if (!target.parent) throw new Error("private tree unavailable");
        setOutcome({ kind: "working", step: "converting" });
        conversion = "started";
        await convertFileCapability(
          target.access,
          target.nodeId,
          target.file,
          target.parent.key,
          target.parent.listing,
          signal,
        );
        conversion = "committed";
        // Refresh now, even if the dialog closes before the invitation resolves.
        onConverted();
      }
      if (!signal.aborted) setOutcome({ kind: "working", step: "inviting" });
      shareId = await inviteShare(target.nodeId, recipient, permission, signal);
    } catch (error) {
      // An interrupted conversion may still have committed.
      if (conversion === "started") onConverted();
      if (!signal.aborted) setOutcome({ kind: "failed", failure: sharingFailure(error) });
      return;
    }
    setIdentifier("");
    void loadLists("/account/sharing");
    setOutcome({ kind: "preparing", progress: null });
    try {
      await prepareShare(shareId, {
        signal,
        onProgress: (progress) => {
          if (!signal.aborted) setOutcome({ kind: "preparing", progress });
        },
      });
      if (!signal.aborted) setOutcome({ kind: "shared" });
    } catch (error) {
      if (!signal.aborted) setOutcome({ kind: "prepare-failed", failure: sharingFailure(error) });
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Share" className="modal-backdrop z-[70]">
      <div className="modal-panel max-h-[90dvh] max-w-xl overflow-y-auto">
        <p className="eyebrow text-accent">{kindName(target.kind, "start")}</p>
        <h2 className="mt-2 font-display text-3xl font-light leading-tight tracking-tight">Share</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Invite one Account by its share identifier. They can find it on their own Sharing page. Collaborators can’t
          share this {label} further.
        </p>
        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            void share();
          }}
        >
          <label htmlFor="share-recipient" className={labelClass}>
            Recipient’s share identifier
          </label>
          <input
            id="share-recipient"
            // biome-ignore lint/a11y/noAutofocus: the Share dialog opens on an explicit action; focus starts in its first field.
            autoFocus
            value={identifier}
            disabled={working}
            onChange={(event) => {
              setIdentifier(event.target.value);
              if (outcome?.kind === "failed") setOutcome(null);
            }}
            required
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            className={cx(fieldClass(), "mt-2 font-mono text-sm")}
          />
          <fieldset className="mt-4">
            <legend className={labelClass}>Permission</legend>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {PERMISSIONS.map((value) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="share-permission"
                    value={value}
                    checked={permission === value}
                    disabled={working}
                    onChange={() => setPermission(value)}
                  />
                  {permissionLabel(value)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="submit" disabled={working || !identifier.trim()} className={buttonClass("primary")}>
              {working ? "Sharing…" : "Share"}
            </button>
          </div>
        </form>
        {outcome?.kind === "working" && (
          <p role="status" className="mt-4 text-sm text-muted">
            {outcome.step === "converting" ? `Preparing this ${label} for sharing…` : "Sending the invitation…"}
          </p>
        )}
        {outcome?.kind === "preparing" && (
          <p role="status" className="mt-4 text-sm text-muted">
            {progressLabel(outcome.progress)}
          </p>
        )}
        {outcome?.kind === "shared" && (
          <p role="status" className={cx(noticeClass("success"), "mt-4")}>
            Invitation sent and secure access prepared. The recipient can accept it from Sharing in their Account menu.
          </p>
        )}
        {outcome?.kind === "prepare-failed" && (
          <p role="alert" className={cx(noticeClass("warning"), "mt-4")}>
            The invitation was sent. <PreparationFailure failure={outcome.failure} />
          </p>
        )}
        {outcome?.kind === "failed" && (
          <p role="alert" className={cx(noticeClass("warning"), "mt-4")}>
            <InviteFailureMessage failure={outcome.failure} />
          </p>
        )}

        <section aria-label="People with access" className="mt-8 border-t border-line pt-5">
          <h3 className="eyebrow text-muted">People with access</h3>
          {intents.state === "idle" && intents.data && <SharingOutcomeNotice outcome={intents.data} className="mt-3" />}
          {!ready ? (
            <p role="status" className="mt-3 text-sm text-muted">
              {lists.data && lists.data.state !== "ready" ? "Sharing is unavailable right now." : "Loading sharing…"}
            </p>
          ) : (
            <>
              {(outgoing.length > 0 || owned.length > 0) && (
                <ul className="mt-1">
                  {outgoing.map((item) => (
                    <OutgoingShareItem key={item.shareId} share={item} Form={intents.Form} busy={rowsBusy} stay>
                      <PrepareSecureAccess shareId={item.shareId} busy={rowsBusy} />
                    </OutgoingShareItem>
                  ))}
                  {owned.map((grant) => (
                    <OwnedGrantItem
                      key={`${grant.grantId}:${grant.revision}`}
                      grant={grant}
                      Form={intents.Form}
                      busy={rowsBusy}
                      stay
                    />
                  ))}
                </ul>
              )}
              {inherited.map(({ folder, collaborators, invitations }) => (
                <p key={folder.id} className="mt-3 text-sm leading-relaxed text-ink-soft">
                  This {label} is also shared through its parent folder{" "}
                  <Link to={sharedTargetPath(folder.id, "directory")} className={linkClass}>
                    {folder.name}
                  </Link>
                  {": "}
                  {[
                    collaborators && `${collaborators} ${collaborators === 1 ? "Collaborator" : "Collaborators"}`,
                    invitations && `${invitations} pending ${invitations === 1 ? "invitation" : "invitations"}`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  . Manage that access on the folder.
                </p>
              ))}
              {!outgoing.length && !owned.length && !inherited.length && (
                <p className="mt-3 text-sm text-muted">Only you can open this {label}.</p>
              )}
            </>
          )}
        </section>
        <div className="mt-7 flex justify-end">
          <button type="button" onClick={onClose} className={buttonClass("ghost")}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
