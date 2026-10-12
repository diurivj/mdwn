import { type ComponentProps, forwardRef, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { clientLoader as rotationsLoader } from "~/routes/account-key-rotations";
import type { clientAction as sharingAction, clientLoader as sharingLoader } from "~/routes/account-sharing";
import { PrivateAccessError } from "~/shared/device/private-client";
import {
  inviteShare,
  KeyRotationRequiredError,
  type RelationshipPermission,
  SharingChangedError,
  SharingNotFoundError,
} from "~/shared/sharing/relationships-client";
import { prepareShare, type SharePreparationProgress } from "~/shared/sharing/share-staging-client";
import { RecoveryConfirmationPendingError } from "~/shared/signup/recovery-gate";
import type { DirectoryListing, RootAccess, TreeKind } from "~/shared/tree/client";
import { convertFileCapability } from "~/shared/tree/file-capability-client";
import type { FilesSnapshot } from "~/tree/navigation-client";
import { cx } from "~/ui/cx";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";
import { PrepareSecureAccess, preparationFailure, progressLabel } from "./prepare-secure-access";
import { OutgoingShareItem, OwnedGrantItem, SharingOutcomeNotice } from "./sharing-management";

/**
 * The workspace **Share** dialog for one owned File or folder. It invites by
 * the recipient's exact share identifier, then prepares secure access from
 * this device. Existing invitations and Collaborators for this target reuse
 * the Sharing page's rows, loader and intents; nothing here is server-rendered.
 */

type Target = {
  access: RootAccess;
  nodeId: string;
  kind: TreeKind;
  /** The current File document, when the target is a File. */
  file: FilesSnapshot["file"];
  /** The File's parent listing and key, used only to convert a legacy File. */
  parent: { listing: DirectoryListing; key: Uint8Array } | null;
  /** The target and its ancestors in this Owner's library. */
  lineage: readonly string[];
};

type Outcome =
  | { kind: "working"; step: "converting" | "inviting" }
  | { kind: "preparing"; progress: SharePreparationProgress | null }
  | { kind: "shared" }
  | { kind: "prepare-failed"; message: string }
  | { kind: "failed"; reason: "not-found" | "self" | "sealed" | "changed" | "access" | "recovery" | "unavailable" };

const FAILURES: Record<Exclude<Extract<Outcome, { kind: "failed" }>["reason"], "sealed">, string> = {
  "not-found": "No Account has that share identifier. Check it with the person you want to share with.",
  self: "That is your own share identifier. You can’t share with yourself.",
  changed: "This sharing changed while you worked. Try again.",
  access: "Use an enrolled device with a current Session to share.",
  recovery: "Confirm your saved recovery phrase and codes before sharing.",
  unavailable: "Sharing is unavailable right now. Try again.",
};

function SealedNotice() {
  return (
    <p role="alert" className={cx(noticeClass("warning"), "mt-4")}>
      A secure access update for this item must finish before it can be shared.{" "}
      <Link to="/account/key-rotations" className={linkClass}>
        Review secure access updates
      </Link>
    </p>
  );
}

export function ShareDialog({
  target,
  onClose,
  onConverted,
}: {
  target: Target;
  onClose: () => void;
  onConverted: () => void;
}) {
  const lists = useFetcher<typeof sharingLoader>();
  const rotations = useFetcher<typeof rotationsLoader>();
  const intents = useFetcher<typeof sharingAction>();
  const [identifier, setIdentifier] = useState("");
  const [permission, setPermission] = useState<RelationshipPermission>("read_only");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const operation = useRef<AbortController | null>(null);
  const converted = useRef(false);
  useEffect(() => () => operation.current?.abort(), []);

  const { load: loadLists } = lists;
  const { load: loadRotations } = rotations;
  useEffect(() => {
    void loadLists("/account/sharing");
    void loadRotations("/account/key-rotations");
  }, [loadLists, loadRotations]);
  // A row intent does not reload Files; this dialog re-reads only its lists.
  const intentDone = intents.state === "idle" && intents.data;
  useEffect(() => {
    if (intentDone) void loadLists("/account/sharing");
  }, [intentDone, loadLists]);

  const ready = lists.data?.state === "ready" ? lists.data : null;
  const sealed =
    rotations.data?.state === "ready" &&
    rotations.data.jobs.some((job) => job.state === "pending" && target.lineage.includes(job.targetId));
  const outgoing = ready?.relationships.outgoing.filter((share) => share.targetId === target.nodeId) ?? [];
  const owned = ready?.relationships.owned.filter((grant) => grant.targetId === target.nodeId) ?? [];
  const working = outcome?.kind === "working" || outcome?.kind === "preparing";
  const rowsBusy = intents.state !== "idle" || lists.state !== "idle" || working;
  const label = target.kind === "file" ? "File" : "folder";

  async function share() {
    const recipient = identifier.trim();
    if (!recipient || working) return;
    if (ready && recipient === ready.shareIdentifier) {
      setOutcome({ kind: "failed", reason: "self" });
      return;
    }
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const { signal } = controller;
    let shareId: string;
    try {
      if (target.kind === "file" && target.file && !target.file.capability) {
        // A legacy File needs its own capability before anyone else can hold it.
        if (!target.parent) throw new Error("private tree unavailable");
        setOutcome({ kind: "working", step: "converting" });
        await convertFileCapability(
          target.access,
          target.nodeId,
          target.file,
          target.parent.key,
          target.parent.listing,
          signal,
        );
        converted.current = true;
      }
      setOutcome({ kind: "working", step: "inviting" });
      shareId = await inviteShare(target.nodeId, recipient, permission, signal);
    } catch (error) {
      if (signal.aborted) return;
      setOutcome({
        kind: "failed",
        reason:
          error instanceof SharingNotFoundError
            ? "not-found"
            : error instanceof KeyRotationRequiredError
              ? "sealed"
              : error instanceof SharingChangedError
                ? "changed"
                : error instanceof RecoveryConfirmationPendingError
                  ? "recovery"
                  : error instanceof PrivateAccessError
                    ? "access"
                    : "unavailable",
      });
      return;
    } finally {
      if (converted.current && !signal.aborted) onConverted();
      converted.current = false;
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
      if (!signal.aborted) setOutcome({ kind: "prepare-failed", message: preparationFailure(error) });
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Share" className="modal-backdrop z-[70]">
      <div className="modal-panel max-h-[90dvh] max-w-xl overflow-y-auto">
        <p className="eyebrow text-accent">{target.kind === "file" ? "File" : "Folder"}</p>
        <h2 className="mt-2 font-display text-3xl font-light leading-tight tracking-tight">Share</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Invite one Account by its share identifier. They can find it on their own Sharing page. Collaborators can’t
          share this {label} further.
        </p>
        {sealed ? (
          <SealedNotice />
        ) : (
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
                {(
                  [
                    ["read_only", "Read only"],
                    ["read_write", "Read & write"],
                  ] as const
                ).map(([value, text]) => (
                  <label key={value} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="share-permission"
                      value={value}
                      checked={permission === value}
                      disabled={working}
                      onChange={() => setPermission(value)}
                    />
                    {text}
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
        )}
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
            The invitation was sent. {outcome.message}
          </p>
        )}
        {outcome?.kind === "failed" &&
          (outcome.reason === "sealed" ? (
            <SealedNotice />
          ) : (
            <p role="alert" className={cx(noticeClass("warning"), "mt-4")}>
              {FAILURES[outcome.reason]}
            </p>
          ))}

        <section aria-label="People with access" className="mt-8 border-t border-line pt-5">
          <h3 className="eyebrow text-muted">People with access</h3>
          {intents.state === "idle" && intents.data && <SharingOutcomeNotice outcome={intents.data} className="mt-3" />}
          {!ready ? (
            <p role="status" className="mt-3 text-sm text-muted">
              {lists.data && lists.data.state !== "ready" ? "Sharing is unavailable right now." : "Loading sharing…"}
            </p>
          ) : outgoing.length || owned.length ? (
            <ul className="mt-1">
              {outgoing.map((item) => (
                <OutgoingShareItem key={item.shareId} share={item} Form={StayForm(intents.Form)} busy={rowsBusy}>
                  <PrepareSecureAccess shareId={item.shareId} busy={rowsBusy} />
                </OutgoingShareItem>
              ))}
              {owned.map((grant) => (
                <OwnedGrantItem
                  key={`${grant.grantId}:${grant.revision}`}
                  grant={grant}
                  Form={StayForm(intents.Form)}
                  busy={rowsBusy}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">Only you can open this {label}.</p>
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

type FetcherForm = ReturnType<typeof useFetcher>["Form"];
const stayForms = new WeakMap<FetcherForm, FetcherForm>();
/** The same fetcher form, but a completed intent never revalidates the Files route (and an unsaved draft). */
function StayForm(Form: FetcherForm): FetcherForm {
  let wrapped = stayForms.get(Form);
  if (!wrapped) {
    wrapped = forwardRef<HTMLFormElement, ComponentProps<FetcherForm>>((props, ref) => (
      <Form {...props} ref={ref} defaultShouldRevalidate={false} />
    )) as FetcherForm;
    stayForms.set(Form, wrapped);
  }
  return wrapped;
}
