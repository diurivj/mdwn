import { type ComponentType, type ReactNode, useState } from "react";
import { Link, type useFetcher } from "react-router";
import type {
  IncomingShare,
  OutgoingShare,
  OwnedGrant,
  ReceivedGrant,
  RelationshipPermission,
  RelationshipTargetKind,
} from "~/shared/sharing/relationships-client";
import type { SharingIntent, SharingOutcome } from "~/shared/sharing/sharing-intents";
import { sharedRootName, sharedTargetPath } from "~/tree/navigation-client";
import { cx } from "~/ui/cx";
import { FileIcon, FolderIcon } from "~/ui/icons";
import { buttonClass, fieldClass, labelClass, linkClass, noticeClass } from "~/ui/styles";

/**
 * Relationship rows for the Sharing page. Every control submits an explicit
 * intent to `/account/sharing`, so a workspace Share dialog can render the
 * same rows for one target. Recipients see generic labels only: names stay
 * encrypted from them. Owner rows show the target kind and an open link.
 */

export const SHARING_ACTION = "/account/sharing";
type SharingForm = ReturnType<typeof useFetcher>["Form"];
type RowProps = { Form: SharingForm; busy: boolean };

export function permissionLabel(permission: RelationshipPermission): string {
  return permission === "read_write" ? "Read/write" : "Read-only";
}

function ownedTargetLabel(kind: RelationshipTargetKind): string {
  return kind === "file" ? "File" : "Folder";
}

function KindIcon({ kind, className }: { kind: RelationshipTargetKind; className?: string }) {
  const Icon: ComponentType<{ className?: string }> = kind === "file" ? FileIcon : FolderIcon;
  return <Icon className={className} />;
}

function expiryLabel(expiresAt: number | null): string {
  return expiresAt === null
    ? "No expiry"
    : `Expires ${new Date(expiresAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`;
}

function localDate(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Hidden fields that address one relationship at the revision the person saw. */
function Fields({ intent, id, revision }: { intent?: SharingIntent; id: string; revision?: number }) {
  return (
    <>
      {intent && <input type="hidden" name="intent" value={intent} />}
      <input type="hidden" name="id" value={id} />
      {revision !== undefined && <input type="hidden" name="revision" value={revision} />}
    </>
  );
}

/** A trigger that opens an inline confirmation before submitting its intent. */
function Confirmed({
  Form,
  busy,
  label,
  confirm,
  tone = "secondary",
  intent,
  id,
  revision,
  extra,
  children,
}: RowProps & {
  label: string;
  confirm: string;
  tone?: "primary" | "secondary" | "danger";
  intent: SharingIntent;
  id: string;
  revision?: number;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        className={buttonClass(tone === "danger" ? "danger-quiet" : tone, "sm")}
      >
        {label}
      </button>
    );
  return (
    <fieldset
      className={cx(
        "basis-full border p-4 text-sm",
        tone === "danger" ? "border-danger/25 bg-danger-soft/50" : "border-line bg-paper",
      )}
    >
      <legend className="sr-only">{label}</legend>
      <div className="space-y-2 leading-relaxed text-ink-soft">{children}</div>
      <Form method="post" action={SHARING_ACTION} className="mt-4 flex flex-wrap gap-2" onSubmit={() => setOpen(false)}>
        <Fields intent={intent} id={id} revision={revision} />
        {extra}
        <button type="submit" disabled={busy} className={buttonClass(tone === "danger" ? "danger" : "primary", "sm")}>
          {confirm}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className={buttonClass("ghost", "sm")}>
          Back
        </button>
      </Form>
    </fieldset>
  );
}

function Row({
  kind,
  title,
  details,
  children,
}: {
  kind: RelationshipTargetKind;
  title: ReactNode;
  details: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-4 border-b border-line py-5 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center border border-line bg-paper text-ink">
          <KindIcon kind={kind} className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="font-display text-xl font-light leading-tight">{title}</p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">{details}</div>
        </div>
      </div>
      {children && <div className="flex flex-wrap items-start gap-2">{children}</div>}
    </li>
  );
}

function RecipientIdentifier({ value }: { value: string }) {
  return (
    <span className="min-w-0">
      Recipient <code className="break-all font-mono text-[13px] text-ink">{value}</code>
    </span>
  );
}

const ROTATION_NOTE = (
  <p>
    New edits under this item wait until a{" "}
    <Link to="/account/key-rotations" className={linkClass}>
      secure access update
    </Link>{" "}
    finishes.
  </p>
);

export function InvitationItem({ share, Form, busy }: RowProps & { share: IncomingShare }) {
  return (
    <Row
      kind={share.targetKind}
      title={sharedRootName(share.targetKind)}
      details={<span>{permissionLabel(share.permission)}</span>}
    >
      <Confirmed
        Form={Form}
        busy={busy}
        label="Accept"
        confirm="Confirm accept"
        tone="primary"
        intent="accept"
        id={share.shareId}
      >
        <p>
          You will be able to open this {share.targetKind === "file" ? "File" : "folder"} as{" "}
          {permissionLabel(share.permission).toLowerCase()}. It appears under Shared with me in your library.
        </p>
      </Confirmed>
      <Confirmed Form={Form} busy={busy} label="Decline" confirm="Confirm decline" intent="decline" id={share.shareId}>
        <p>The invitation is removed. The Owner can invite you again.</p>
      </Confirmed>
    </Row>
  );
}

export function ReceivedGrantItem({ grant, Form, busy }: RowProps & { grant: ReceivedGrant }) {
  return (
    <Row
      kind={grant.targetKind}
      title={sharedRootName(grant.targetKind)}
      details={
        <>
          <span>{permissionLabel(grant.permission)}</span>
          <span>{expiryLabel(grant.expiresAt)}</span>
        </>
      }
    >
      <Link to={sharedTargetPath(grant.targetId, grant.targetKind)} className={buttonClass("secondary", "sm")}>
        {grant.targetKind === "file" ? "Open File" : "Open folder"}
      </Link>
      <Confirmed
        Form={Form}
        busy={busy}
        label="Leave"
        confirm="Confirm leave"
        tone="danger"
        intent="leave"
        id={grant.grantId}
        revision={grant.revision}
      >
        <p>Your access ends now. Only the Owner can share it with you again.</p>
      </Confirmed>
    </Row>
  );
}

/**
 * A pending outgoing Share. `children` is the slot for further Owner actions
 * on the same invitation (such as preparing secure access again).
 */
export function OutgoingShareItem({
  share,
  Form,
  busy,
  children,
}: RowProps & { share: OutgoingShare; children?: ReactNode }) {
  return (
    <Row
      kind={share.targetKind}
      title={
        <Link to={sharedTargetPath(share.targetId, share.targetKind)} className={linkClass}>
          {ownedTargetLabel(share.targetKind)}
        </Link>
      }
      details={
        <>
          <RecipientIdentifier value={share.recipientShareId} />
          <span>{permissionLabel(share.permission)}</span>
          <span className="text-muted">Waiting for acceptance</span>
        </>
      }
    >
      {children}
      <Confirmed
        Form={Form}
        busy={busy}
        label="Cancel invitation"
        confirm="Confirm cancel"
        tone="danger"
        intent="cancel"
        id={share.shareId}
      >
        <p>The pending invitation is withdrawn before it is accepted.</p>
      </Confirmed>
    </Row>
  );
}

export function OwnedGrantItem({ grant, Form, busy }: RowProps & { grant: OwnedGrant }) {
  const next: RelationshipPermission = grant.permission === "read_write" ? "read_only" : "read_write";
  const today = localDate(Date.now());
  return (
    <Row
      kind={grant.targetKind}
      title={
        <Link to={sharedTargetPath(grant.targetId, grant.targetKind)} className={linkClass}>
          {ownedTargetLabel(grant.targetKind)}
        </Link>
      }
      details={
        <>
          <RecipientIdentifier value={grant.recipientShareId} />
          <span>{permissionLabel(grant.permission)}</span>
          <span>{expiryLabel(grant.expiresAt)}</span>
        </>
      }
    >
      <Confirmed
        Form={Form}
        busy={busy}
        label={next === "read_only" ? "Make read-only" : "Allow editing"}
        confirm="Confirm permission change"
        intent="permission"
        id={grant.grantId}
        revision={grant.revision}
        extra={<input type="hidden" name="permission" value={next} />}
      >
        <p>
          Their current access ends now and continues as {permissionLabel(next).toLowerCase()} once secure access is
          prepared again.
        </p>
        {ROTATION_NOTE}
      </Confirmed>
      <Confirmed
        Form={Form}
        busy={busy}
        label="Revoke"
        confirm="Confirm revoke"
        tone="danger"
        intent="revoke"
        id={grant.grantId}
        revision={grant.revision}
      >
        <p>Their access ends now. It cannot erase anything their devices already cached.</p>
        {ROTATION_NOTE}
      </Confirmed>
      <Form method="post" action={SHARING_ACTION} className="flex basis-full flex-wrap items-end gap-2">
        {/* The submitter names the intent: Set expiry is the default for Enter. */}
        <Fields id={grant.grantId} revision={grant.revision} />
        <div>
          <label htmlFor={`expiry-${grant.grantId}`} className={labelClass}>
            Expiry date
          </label>
          <input
            id={`expiry-${grant.grantId}`}
            type="date"
            name="expiresOn"
            required
            min={today}
            defaultValue={grant.expiresAt === null ? "" : localDate(grant.expiresAt)}
            disabled={busy}
            className={cx(fieldClass("sm"), "mt-2 w-auto")}
          />
        </div>
        <button
          type="submit"
          name="intent"
          value="set-expiry"
          disabled={busy}
          className={buttonClass("secondary", "sm")}
        >
          Set expiry
        </button>
        {grant.expiresAt !== null && (
          <button
            type="submit"
            name="intent"
            value="clear-expiry"
            formNoValidate
            disabled={busy}
            className={buttonClass("ghost", "sm")}
          >
            Clear expiry
          </button>
        )}
      </Form>
    </Row>
  );
}

const DONE: Record<NonNullable<SharingOutcome["intent"]>, string> = {
  accept: "Invitation accepted. It is listed under Shared with me in your library.",
  decline: "Invitation declined.",
  cancel: "Invitation cancelled.",
  leave: "You left the shared item. Your access has ended.",
  revoke: "Access revoked. New edits under that item wait until a secure access update finishes.",
  permission: "Permission changed. New edits under that item wait until a secure access update finishes.",
  "set-expiry": "Expiry set.",
  "clear-expiry": "Expiry cleared.",
};

/** The result of one submitted Sharing intent, for the Sharing page and the Share dialog. */
export function SharingOutcomeNotice({ outcome, className }: { outcome: SharingOutcome; className?: string }) {
  if (outcome.state === "done" && outcome.intent)
    return (
      <p role="status" className={cx(noticeClass("success"), className)}>
        {DONE[outcome.intent]}
        {(outcome.intent === "revoke" || outcome.intent === "permission") && (
          <>
            {" "}
            <Link to="/account/key-rotations" className={linkClass}>
              Review secure access updates
            </Link>
          </>
        )}
      </p>
    );
  const message =
    outcome.state === "changed" && outcome.intent === "accept"
      ? "The Owner’s browser is still preparing secure access for your devices, or the invitation changed. Try again later, or refresh."
      : outcome.state === "changed"
        ? "This sharing changed while you worked. Review the refreshed list and try again."
        : outcome.state === "not-found"
          ? "That sharing no longer exists. The list has been refreshed."
          : outcome.state === "invalid"
            ? outcome.intent === "set-expiry"
              ? "Choose a date from today onward for the expiry."
              : "That request was not valid. Refresh and try again."
            : outcome.state === "access"
              ? "Use an enrolled device with a current Session to manage sharing."
              : "Sharing is unavailable right now. Refresh and try again.";
  return (
    <p role="alert" className={cx(noticeClass("warning"), className)}>
      {message}
    </p>
  );
}
