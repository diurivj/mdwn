import { type ComponentType, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useNavigation, useRevalidator } from "react-router";
import { ensurePrivateThread } from "~/shared/comments/comments-client";
import { ExportControl } from "~/export/export-control";
import { ImportControl, type ImportControlHandle } from "~/import/import-control";
import { createPublicationOperations } from "~/publications/publication-operations";
import { declarePublicationAuthor } from "~/publications/publications-client";
import { PublishPanel } from "~/publications/publish-panel";
import { PublicationLifecycle, type PublicationContext } from "~/shared/publications/lifecycle";
import { isSignupRecoveryConfirmationPending, RecoveryConfirmationPendingError } from "~/shared/signup/recovery-gate";
import { SharedProvisioning } from "~/sharing/shared-provisioning";
import { ShareDialog } from "~/sharing/share-dialog";
import { SharedWithMeSection } from "~/sharing/shared-with-me";
import { cx } from "~/ui/cx";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CloseIcon,
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  MoveIcon,
  PencilIcon,
  RefreshIcon,
  ShareIcon,
  TrashIcon,
  UserIcon,
} from "~/ui/icons";
import { SkeletonLines } from "~/ui/page-layouts";
import { useDelayedFlag, usePendingLocation } from "~/ui/pending-navigation";
import { buttonClass, fieldClass, labelClass, noticeClass, textButtonClass } from "~/ui/styles";

import {
  createTreeChild,
  loadDirectory,
  NameConflictError,
  NamespaceChangedError,
  reorderTreeChild,
  moveTreeChild,
  deleteTreeChild,
  DirectoryTooLargeError,
  openChildDirectory,
  prepareTreeCreate,
  prepareTreeRename,
  renameTreeChild,
  TreeCommitUncertainError,
  TreeNotFoundError,
  type TreeEntry,
  type TreeKind,
} from "../shared/tree/client";
import { FileEditor } from "./file-editor";
import {
  type Crumb,
  expandedPreferenceKey,
  kindName,
  type FilesPageData,
  type FilesSnapshot,
  nodePath,
  rootName,
  savedExpanded,
} from "./navigation-client";

type Destination = { nodeId: string; kind: TreeKind; name: string | null; crumbs: Crumb[] | null };

/**
 * A workspace link's target described from what this page already decrypted:
 * its name and breadcrumb path when a loaded listing contains it. Nothing is
 * fetched, so the next page still renders only its own verified walk.
 */
function destinationOf(pathname: string, snapshot: FilesSnapshot): Destination | null {
  const { access } = snapshot;
  const match = /^\/([df])\/([^/]+)$/.exec(pathname);
  if (pathname !== "/files" && !match) return null;
  const ownRoot = access.vaultId === access.actorAccountId;
  if (!match && !ownRoot)
    return { nodeId: "", kind: "directory", name: "Library", crumbs: [{ id: "", name: "Library" }] };
  const nodeId = match ? match[2]! : access.rootId;
  const kind: TreeKind = match?.[1] === "f" ? "file" : "directory";
  const crumbs: Crumb[] = [];
  let current = nodeId;
  for (let depth = 0; depth <= 100; depth++) {
    if (current === access.rootId) {
      crumbs.unshift({ id: current, name: rootName(access) });
      return { nodeId, kind, name: crumbs.at(-1)!.name, crumbs };
    }
    const parent = Object.values(snapshot.listings).find((listing) =>
      listing.entries.some((entry) => entry.nodeId === current),
    );
    const entry = parent?.entries.find((item) => item.nodeId === current);
    if (!parent || !entry) break;
    crumbs.unshift({ id: current, name: entry.name });
    current = parent.directoryId;
  }
  return { nodeId, kind, name: crumbs.at(-1)?.id === nodeId ? crumbs.at(-1)!.name : null, crumbs: null };
}

type DialogFields = {
  kind: TreeKind;
  parentId: string;
  requestedName: string;
  review?: "local" | "changed";
  needsRefresh?: boolean;
};
type Dialog = DialogFields &
  (
    | { operation: "create" }
    | { operation: "rename"; nodeId: string }
    | { operation: "move"; nodeId: string; destinationId: string; path: { id: string; name: string }[] }
    | { operation: "delete"; nodeId: string; consent: boolean; tooLarge?: boolean }
    | { operation: "reorder"; nodeId: string; direction: "up" | "down" }
  );
const dialogLabels = {
  create: { label: "Create a name", heading: "New", submit: "Create" },
  rename: { label: "Rename", heading: "Rename", submit: "Rename" },
  move: { label: "Move", heading: "Move", submit: "Move" },
  delete: { label: "Delete permanently", heading: "Delete permanently", submit: "Delete permanently" },
  reorder: { label: "Reorder", heading: "Reorder", submit: "Retry reorder" },
};

/** RR supports one blocker: File drafts own it; other views observe the
 * same synchronous navigation-intent boundary without blocking the person.
 */
function NavigationIntentObserver({ onStart }: { onStart: () => void }) {
  useBlocker(() => {
    onStart();
    return false;
  });
  return null;
}

export function FilesPage({ nodeId, kind, initial }: { nodeId: string; kind: TreeKind; initial: FilesPageData }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [snapshot, setSnapshot] = useState<FilesSnapshot | null>(initial.snapshot);
  const [status, setStatus] = useState<FilesPageData["status"]>(initial.status);
  const [expanded, setExpanded] = useState<string[]>([]);
  // The latest expanded set, for folder loads that complete after other changes.
  const expandedNow = useRef<string[]>([]);
  const showExpanded = useCallback((next: string[]) => {
    expandedNow.current = next;
    setExpanded(next);
  }, []);
  const [drawer, setDrawer] = useState(false);
  const [view, setView] = useState<"edit" | "preview" | "comments">("edit");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Folders shown open while their listing loads after an expand click.
  const [opening, setOpening] = useState<ReadonlySet<string>>(() => new Set());
  // One lifecycle per File page. It retains every prepared candidate for this
  // page's lifetime, orders reads and drives Unpublishing teardown; complete
  // links stay only in browser memory, never in persistent storage. It is
  // created in the page's own effect so a development StrictMode remount
  // starts a live instance instead of leaving a disposed one latched.
  const [publicationLifecycle, setPublicationLifecycle] = useState<PublicationLifecycle | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const importControl = useRef<ImportControlHandle | null>(null);
  const submission = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      lifetime.current?.abort();
    };
  }, []);
  // Same-File revalidation keeps the lifecycle and its retained candidates;
  // later operations use the current access/context.
  const publicationContext = useMemo<PublicationContext | null>(() => {
    if (!snapshot) return null;
    const parentId = snapshot.file?.parentId ?? null;
    return {
      fileId: nodeId,
      access: snapshot.access,
      parentId,
      parentKey: parentId ? (snapshot.keys[parentId] ?? null) : snapshot.access.rootKey,
    };
  }, [snapshot, nodeId]);
  useEffect(() => {
    const lifecycle = new PublicationLifecycle(createPublicationOperations());
    setPublicationLifecycle(lifecycle);
    return () => lifecycle.dispose();
  }, []);
  useEffect(() => {
    if (publicationContext && publicationLifecycle) publicationLifecycle.updateContext(publicationContext);
  }, [publicationLifecycle, publicationContext]);
  const onNavigationStart = useCallback(() => {
    lifetime.current?.abort();
    lifetime.current = new AbortController();
    if (submission.current) setMessage("Navigation interrupted this operation. Refresh the page before trying again.");
    submission.current = false;
    setSubmitting(false);
    setDialog(null);
    setShareOpen(false);
  }, []);
  const route = useRef(`${kind}/${nodeId}`);
  const ensuredThread = useRef<string | null>(null);
  const [structuralReady, setStructuralReady] = useState(false);
  const [editorParent, setEditorParent] = useState(initial.snapshot?.file?.parentId);
  const fileReady = structuralReady && editorParent === snapshot?.file?.parentId;

  useEffect(() => {
    if (editorParent === snapshot?.file?.parentId) return;
    // Release the previous editor's Web Lock before the new parent-bound draft mounts.
    setStructuralReady(false);
    const frame = requestAnimationFrame(() => setEditorParent(snapshot?.file?.parentId));
    return () => cancelAnimationFrame(frame);
  }, [editorParent, snapshot?.file?.parentId]);
  const [message, setMessage] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const busy = submitting || revalidator.state !== "idle" || navigation.state !== "idle";
  const recoveryPending = isSignupRecoveryConfirmationPending();

  const dialogRef = useRef(dialog);
  useEffect(() => {
    dialogRef.current = dialog;
  }, [dialog]);

  useEffect(() => {
    setSnapshot((previous) =>
      initial.snapshot && previous && dialogRef.current && route.current === `${kind}/${nodeId}`
        ? {
            ...initial.snapshot,
            keys: { ...previous.keys, ...initial.snapshot.keys },
            listings: { ...previous.listings, ...initial.snapshot.listings },
          }
        : initial.snapshot,
    );
    setStatus(initial.status);
    if (route.current !== `${kind}/${nodeId}`) {
      setDialog(null);
      setPublishOpen(false);
      setShareOpen(false);
      setStructuralReady(false);
      setView("edit");
      route.current = `${kind}/${nodeId}`;
    }
    if (initial.snapshot)
      showExpanded(
        Array.from(
          new Set([
            ...savedExpanded(initial.snapshot.access.actorAccountId),
            ...initial.snapshot.crumbs.slice(0, -1).map((item) => item.id),
            initial.snapshot.access.rootId,
          ]),
        ),
      );
  }, [initial, nodeId, kind, showExpanded]);

  // Owner-side upkeep: opening any File ensures its one Private thread exists,
  // so a Collaborator never waits for an Owner to open the Comments inspector.
  useEffect(() => {
    if (kind !== "file" || !snapshot || snapshot.access.actorAccountId !== snapshot.access.vaultId) return;
    if (ensuredThread.current === nodeId) return;
    ensuredThread.current = nodeId;
    void ensurePrivateThread(snapshot.access, nodeId).catch(() => {
      /* The next File open retries. */
    });
  }, [kind, nodeId, snapshot]);

  // A credited author's own device declares its Public pseudonym; the Owner's
  // selection alone never writes one, and nothing is inferred from edits.
  const declared = useRef<string | null>(null);
  useEffect(() => {
    const publication = kind === "file" ? snapshot?.file?.publication : null;
    if (!snapshot || !publication?.declaration || publication.declaration.current) return;
    const key = `${nodeId}/${publication.linkId}/${publication.declaration.revision}`;
    if (declared.current === key) return;
    declared.current = key;
    void declarePublicationAuthor(snapshot.access, nodeId, publication).catch(() => {
      /* The next File open retries. */
    });
  }, [kind, nodeId, snapshot]);

  async function toggle(entry: TreeEntry) {
    const signal = lifetime.current?.signal;
    if (!snapshot || entry.kind !== "directory" || !signal || signal.aborted || opening.has(entry.nodeId)) return;
    const preference = expandedPreferenceKey(snapshot.access.actorAccountId);
    if (expandedNow.current.includes(entry.nodeId)) {
      const next = expandedNow.current.filter((id) => id !== entry.nodeId);
      showExpanded(next);
      localStorage.setItem(preference, JSON.stringify(next));
      return;
    }
    // Open at once; the folder's fresh listing replaces its placeholder when it arrives.
    setOpening((current) => new Set(current).add(entry.nodeId));
    try {
      const parentId = Object.values(snapshot.listings).find((listing) =>
        listing.entries.some((child) => child.nodeId === entry.nodeId),
      )?.directoryId;
      const parentKey = parentId && snapshot.keys[parentId];
      if (!parentKey) throw new Error("private tree unavailable");
      const key = await openChildDirectory(snapshot.access, parentKey, entry);
      const listing = await loadDirectory(snapshot.access, entry.nodeId, key, signal);
      if (signal.aborted) return;
      setSnapshot(
        (previous) =>
          previous && {
            ...previous,
            keys: { ...previous.keys, [entry.nodeId]: key },
            listings: { ...previous.listings, [entry.nodeId]: listing },
          },
      );
      // Several folders may open at once; each completion extends the latest set.
      const next = [...expandedNow.current, entry.nodeId];
      showExpanded(next);
      localStorage.setItem(preference, JSON.stringify(next));
    } catch {
      if (!signal.aborted) setMessage("This folder could not be opened. Refresh and try again.");
    } finally {
      setOpening((current) => {
        const next = new Set(current);
        next.delete(entry.nodeId);
        return next;
      });
    }
  }

  function startCreate(createKind: TreeKind) {
    if (!snapshot) return;
    const parentId = kind === "directory" ? nodeId : snapshot.crumbs.at(-2)?.id;
    if (!parentId || !snapshot.listings[parentId] || snapshot.listings[parentId].canCreate === false) return;
    setMessage("");
    setDialog({ operation: "create", kind: createKind, parentId, requestedName: "" });
  }

  function startRename() {
    if (!snapshot || nodeId === snapshot.access.rootId) return;
    const parentId = snapshot.crumbs.at(-2)?.id;
    const entry = parentId && snapshot.listings[parentId]?.entries.find((item) => item.nodeId === nodeId);
    if (!entry || !parentId) return;
    setMessage("");
    setDialog({ operation: "rename", kind, parentId, nodeId, requestedName: entry.name });
  }

  async function refreshed(current: Dialog, signal: AbortSignal): Promise<FilesSnapshot> {
    if (!snapshot) throw new Error("private tree unavailable");
    const ids = new Set([
      current.parentId,
      ...(current.operation === "move" ? [current.destinationId] : []),
      ...(current.operation === "delete" && current.kind === "directory" ? [current.nodeId] : []),
    ]);
    const listings = { ...snapshot.listings };
    for (const id of ids) listings[id] = await loadDirectory(snapshot.access, id, snapshot.keys[id]!, signal);
    signal.throwIfAborted();
    const next = { ...snapshot, listings };
    setSnapshot(next);
    return next;
  }

  function startStructural(
    action: { operation: "move" } | { operation: "delete" } | { operation: "reorder"; direction: "up" | "down" },
  ) {
    if (!snapshot || busy || (kind === "file" && !fileReady)) return;
    const parentId = snapshot.crumbs.at(-2)?.id;
    const entry = parentId && snapshot.listings[parentId]?.entries.find((item) => item.nodeId === nodeId);
    if (!parentId || !entry) return;
    const fields = { kind, parentId, nodeId, requestedName: entry.name };
    const current: Dialog =
      action.operation === "move"
        ? {
            ...fields,
            operation: "move",
            destinationId: snapshot.access.rootId,
            path: [{ id: snapshot.access.rootId, name: rootName(snapshot.access) }],
          }
        : action.operation === "delete"
          ? { ...fields, operation: "delete", consent: false }
          : { ...fields, ...action };
    setMessage("");
    setDialog(current);
    if (current.operation === "reorder") void submit(current);
  }

  async function chooseFolder(entry: TreeEntry) {
    const signal = lifetime.current?.signal;
    if (!snapshot || dialog?.operation !== "move" || busy || submission.current || !signal || signal.aborted) return;
    submission.current = true;
    setSubmitting(true);
    try {
      const parentId = dialog.destinationId;
      const key = await openChildDirectory(snapshot.access, snapshot.keys[parentId]!, entry);
      const listing = await loadDirectory(snapshot.access, entry.nodeId, key, signal);
      if (signal.aborted) return;
      setSnapshot(
        (previous) =>
          previous && {
            ...previous,
            keys: { ...previous.keys, [entry.nodeId]: key },
            listings: { ...previous.listings, [entry.nodeId]: listing },
          },
      );
      setDialog({
        ...dialog,
        destinationId: entry.nodeId,
        path: [...dialog.path, { id: entry.nodeId, name: entry.name }],
        review: undefined,
      });
    } catch {
      if (!signal.aborted) setMessage("This folder could not be opened. Refresh and try again.");
    } finally {
      if (!signal.aborted) {
        submission.current = false;
        setSubmitting(false);
      }
    }
  }

  async function submit(current: Dialog) {
    const signal = lifetime.current?.signal;
    if (
      !snapshot ||
      busy ||
      submission.current ||
      !signal ||
      signal.aborted ||
      (current.operation !== "create" && kind === "file" && !fileReady)
    )
      return;
    if (current.operation === "delete" && (!current.consent || current.tooLarge)) return;
    if (current.operation === "move" && current.destinationId === current.parentId) return;
    submission.current = true;
    setSubmitting(true);
    setMessage("");
    try {
      const active = current.needsRefresh ? await refreshed(current, signal) : snapshot;
      const parent = active.listings[current.parentId];
      const key = active.keys[current.parentId];
      if (!parent || !key || parent.canCreate === false) throw new Error("private tree unavailable");
      if (current.operation === "create") {
        const payload = await prepareTreeCreate({
          vaultId: snapshot.access.vaultId,
          parentId: current.parentId,
          parentKey: key,
          parentEpoch: parent.keyEpoch ?? 1,
          entriesRevision: parent.entriesRevision,
          existingNames: parent.entries.map((entry) => entry.name),
          requestedName: current.requestedName,
          kind: current.kind,
        });
        const created = await createTreeChild(snapshot.access, current.parentId, payload, parent, key, signal);
        if (signal.aborted) return;
        setDialog(null);
        // Opening the new node completes this operation; it does not interrupt it.
        submission.current = false;
        navigate(`/${current.kind === "directory" ? "d" : "f"}/${created.nodeId}`);
      } else if (current.operation === "reorder" || current.operation === "move" || current.operation === "delete") {
        if (current.operation === "reorder")
          await reorderTreeChild(active.access, parent, key, current.nodeId, current.direction, signal);
        else if (current.operation === "move")
          await moveTreeChild(
            active.access,
            parent,
            key,
            active.listings[current.destinationId]!,
            active.keys[current.destinationId]!,
            current.nodeId,
            current.requestedName,
            signal,
          );
        else
          await deleteTreeChild(
            active.access,
            parent,
            key,
            current.nodeId,
            current.kind === "directory" ? active.listings[current.nodeId]?.entriesRevision : undefined,
            signal,
          );
        if (signal.aborted) return;
        setDialog(null);
        if (current.operation === "delete") {
          submission.current = false;
          navigate(nodePath(active.access, current.parentId, "directory"));
        } else revalidator.revalidate();
      } else {
        const entry = parent.entries.find((item) => item.nodeId === current.nodeId);
        if (!entry) throw new TreeNotFoundError();
        const payload = await prepareTreeRename({
          vaultId: snapshot.access.vaultId,
          parentId: current.parentId,
          parentKey: key,
          parentEpoch: parent.keyEpoch ?? 1,
          nodeId: entry.nodeId,
          entriesRevision: parent.entriesRevision,
          existingNames: parent.entries.filter((item) => item.nodeId !== entry.nodeId).map((item) => item.name),
          requestedName: current.requestedName,
          order: entry.order,
        });
        await renameTreeChild(snapshot.access, current.parentId, entry.nodeId, payload, parent, key, signal);
        if (signal.aborted) return;
        setDialog(null);
        revalidator.revalidate();
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof NameConflictError) setDialog({ ...current, review: "local", needsRefresh: true });
      else if (error instanceof NamespaceChangedError) {
        setDialog(
          current.operation === "delete"
            ? { ...current, review: "changed", needsRefresh: true, consent: false }
            : { ...current, review: "changed", needsRefresh: true },
        );
        try {
          await refreshed(current, signal);
        } catch {
          if (!signal.aborted) setMessage("The folder could not be refreshed. Try again.");
        }
      } else if (error instanceof DirectoryTooLargeError && current.operation === "delete")
        setDialog({ ...current, tooLarge: true, consent: false });
      else if (error instanceof TreeNotFoundError) {
        setDialog(null);
        setStatus("not-found");
      } else if (error instanceof TreeCommitUncertainError) {
        setDialog(null);
        setMessage(
          "The change may have been saved, but its local checkpoint failed. Refresh the page before trying again.",
        );
      } else if (error instanceof RecoveryConfirmationPendingError) {
        setDialog(null);
        setMessage("Confirm your saved recovery phrase and codes before creating Files.");
      } else setMessage("The change could not be confirmed. Refresh the page before trying again.");
    } finally {
      if (!signal.aborted) {
        submission.current = false;
        setSubmitting(false);
      }
    }
  }

  async function refreshAndRetry(current: Dialog) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    if (current.operation === "delete") {
      if (busy || submission.current) return;
      submission.current = true;
      setSubmitting(true);
      try {
        await refreshed(current, signal);
        if (signal.aborted) return;
        setDialog({ ...current, review: undefined, needsRefresh: false, consent: false });
      } catch {
        if (!signal.aborted) setMessage("The folder could not be refreshed. Try again.");
      } finally {
        if (!signal.aborted) {
          submission.current = false;
          setSubmitting(false);
        }
      }
    } else await submit({ ...current, review: undefined, needsRefresh: true });
  }

  // A link navigation's destination, previewed from what this page already
  // decrypted: it is selected in the tree at once, and its frame replaces this
  // page's content if loading takes long enough to notice.
  const pendingLocation = usePendingLocation();
  const destination = useMemo(
    () => (pendingLocation && snapshot ? destinationOf(pendingLocation.pathname, snapshot) : null),
    [pendingLocation, snapshot],
  );
  const pending = destination && destination.nodeId !== nodeId ? destination : null;
  const showPending = useDelayedFlag(pending !== null);
  const selectedId = pending?.nodeId ?? nodeId;

  function directoryItems(directoryId: string, depth = 0): React.ReactNode {
    if (!snapshot || depth > 100) return null;
    const listing = snapshot.listings[directoryId];
    if (!listing) return null;
    return listing.entries.map((entry) => {
      const loading = opening.has(entry.nodeId);
      const open = expanded.includes(entry.nodeId) || loading;
      const current = entry.nodeId === nodeId;
      const arriving = pending?.nodeId === entry.nodeId;
      return (
        <div key={entry.nodeId}>
          <div
            className={cx(
              "flex items-center border-l-2 pr-2 text-sm transition-colors",
              entry.nodeId === selectedId
                ? "border-ink bg-paper text-ink"
                : "border-transparent text-ink-soft hover:bg-paper hover:text-ink",
            )}
            style={{ paddingLeft: `${depth * 14 + 2}px` }}
          >
            {entry.kind === "directory" ? (
              <button
                type="button"
                aria-label={`${open ? "Collapse" : "Expand"} ${entry.name}`}
                aria-expanded={open}
                onClick={() => void toggle(entry)}
                className="grid size-7 shrink-0 place-items-center text-muted transition-colors hover:bg-ink/5 hover:text-ink"
              >
                <ChevronRightIcon className={cx("size-3.5 transition-transform duration-200", open && "rotate-90")} />
              </button>
            ) : (
              <span className="size-7 shrink-0" aria-hidden="true" />
            )}
            <Link
              to={nodePath(snapshot.access, entry.nodeId, entry.kind)}
              onClick={() => setDrawer(false)}
              aria-current={current ? "page" : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5"
            >
              {entry.kind === "directory" ? (
                <FolderIcon className="text-accent/80" />
              ) : (
                <FileIcon className="text-muted" />
              )}
              <span className="truncate">{entry.name}</span>
              {arriving && (
                <span aria-hidden="true" className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              )}
            </Link>
          </div>
          {entry.kind === "directory" &&
            open &&
            (snapshot.listings[entry.nodeId] ? (
              directoryItems(entry.nodeId, depth + 1)
            ) : (
              <div
                aria-hidden="true"
                className="flex h-8 animate-fade items-center"
                style={{ paddingLeft: `${(depth + 1) * 14 + 30}px` }}
              >
                <span className="skeleton h-3 w-28" />
              </div>
            ))}
        </div>
      );
    });
  }

  if (status === "not-found")
    return (
      <EmptyState icon={FileIcon} title="Not found">
        <p>This File or folder is unavailable.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/files" className={buttonClass("primary")}>
            Back to your library
          </Link>
          <Link to="/account/device-access" className={buttonClass("secondary")}>
            Files access
          </Link>
        </div>
      </EmptyState>
    );
  if (status === "provisioning")
    return (
      <EmptyState icon={KeyIcon}>
        <p
          role="status"
          className="font-display text-3xl font-light leading-tight tracking-tight text-ink text-balance sm:text-4xl"
        >
          Shared content is being securely provisioned
        </p>
        <p className="mt-3">
          An authorized device delivers your keys the next time it opens mdwn. Nothing private is shown until then.
        </p>
        <button
          type="button"
          onClick={() => void revalidator.revalidate()}
          disabled={revalidator.state !== "idle"}
          className={cx(buttonClass("primary"), "mt-8")}
        >
          <RefreshIcon className={cx(revalidator.state !== "idle" && "animate-spin")} />
          Check shared access
        </button>
      </EmptyState>
    );
  if (status !== "ready" || !snapshot)
    return (
      <EmptyState icon={LockIcon} title="Files unavailable">
        <p>Check this device’s access or try again.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/account/device-access" className={buttonClass("primary")}>
            Device access
          </Link>
        </div>
      </EmptyState>
    );

  const selected = snapshot.crumbs.at(-1)?.name ?? rootName(snapshot.access);
  const eyebrow = kind === "file" ? "Markdown" : nodeId === snapshot.access.rootId ? null : "Folder";
  const crumbs = showPending ? (pending?.crumbs ?? []) : snapshot.crumbs;
  const crumbKind = showPending ? pending?.kind : kind;
  const owner = snapshot.access.actorAccountId === snapshot.access.vaultId;
  const structuralParent = kind === "directory" ? nodeId : snapshot.file?.parentId;
  const canCreate =
    !!structuralParent &&
    snapshot.listings[structuralParent]?.canCreate !== false &&
    !!snapshot.listings[structuralParent];
  const canChangeStructure =
    nodeId !== snapshot.access.rootId && snapshot.listings[snapshot.crumbs.at(-2)?.id ?? ""]?.canCreate !== false;
  const structureBlocked = busy || recoveryPending || (kind === "file" && !fileReady);
  const siblings = snapshot.listings[snapshot.crumbs.at(-2)?.id ?? ""]?.entries ?? [];
  const position = siblings.findIndex((entry) => entry.nodeId === nodeId);
  const folderEntries = kind === "directory" ? (snapshot.listings[nodeId]?.entries ?? []) : [];
  // Owners share their own Files and folders; the Library root and content
  // shared with you (Collaborators cannot reshare) offer no Share action.
  const canShare = owner && nodeId !== snapshot.access.rootId && (kind === "directory" || !!snapshot.file);
  const shareParentId = kind === "file" ? snapshot.file?.parentId : null;
  return (
    <main
      aria-busy={showPending || undefined}
      className="w-full lg:grid lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[17.5rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)]"
    >
      {(kind === "directory" || editorParent !== snapshot.file?.parentId) && (
        <NavigationIntentObserver onStart={onNavigationStart} />
      )}
      {drawer && (
        <button
          type="button"
          aria-label="Close Files tree"
          onClick={() => setDrawer(false)}
          className="fixed inset-0 z-40 animate-fade bg-ink/40 lg:hidden"
        />
      )}
      <aside
        className={cx(
          drawer ? "flex" : "hidden",
          "fixed inset-y-0 left-0 z-50 w-[19rem] max-w-[86vw] flex-col overflow-y-auto overscroll-contain border-r border-line bg-sand transition-[translate] duration-300 ease-out max-lg:starting:-translate-x-full lg:sticky lg:top-16 lg:z-auto lg:flex lg:h-[calc(100dvh-4rem)] lg:w-auto lg:max-w-none",
        )}
        aria-label="Files tree"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line py-3 pr-3 pl-5 lg:hidden">
          <p className="eyebrow text-muted">{rootName(snapshot.access)}</p>
          <button type="button" onClick={() => setDrawer(false)} className={buttonClass("ghost", "sm")}>
            <CloseIcon />
            Close tree
          </button>
        </div>
        <div className="flex-1 px-3 py-5 lg:px-4 lg:py-7">
          <Link
            to={nodePath(snapshot.access, snapshot.access.rootId, snapshot.access.rootKind ?? "directory")}
            onClick={() => setDrawer(false)}
            aria-current={nodeId === snapshot.access.rootId ? "page" : undefined}
            className={cx(
              "mb-4 block border-b border-line px-2 pb-4 font-display text-[1.7rem] font-light leading-tight tracking-tight transition-colors hover:text-ink",
              selectedId === snapshot.access.rootId ? "text-ink" : "text-ink-soft",
            )}
          >
            {rootName(snapshot.access)}
          </Link>
          <nav aria-label="Files" className="space-y-px">
            {directoryItems(snapshot.access.rootId)}
          </nav>
          {snapshot.access.rootKind !== "file" && snapshot.listings[snapshot.access.rootId]?.entries.length === 0 && (
            <p className="px-2 text-sm text-muted">Nothing here yet. Create your first File.</p>
          )}
        </div>
        <SharedWithMeSection accountId={snapshot.access.actorAccountId} currentId={nodeId} />
        <div className="border-t border-line px-3 py-4 text-sm lg:px-4">
          <SharedProvisioning link={false} className="px-2 [&:not(:empty)]:mb-3" />
          <ul>
            {[
              { to: "/account/sharing", label: "Sharing", icon: ShareIcon },
              { to: "/account/shared-access", label: "Shared access", icon: ShareIcon },
              ...(owner
                ? [
                    { to: "/account/pseudonym", label: "Public pseudonym", icon: UserIcon },
                    { to: "/account/key-rotations", label: "Secure access updates", icon: KeyIcon },
                  ]
                : []),
            ].map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <Link
                  to={to}
                  className="flex items-center gap-2 px-2 py-1.5 text-ink-soft transition-colors hover:bg-paper hover:text-ink"
                >
                  <Icon className="text-muted" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only File drop target; the Import control exposes a labelled file picker for keyboard users. */}
      <section
        className="min-w-0 px-4 pt-5 pb-16 sm:px-6 lg:px-10 lg:pt-8"
        onDragOver={(event) => {
          if (importControl.current?.canAcceptDrop()) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          if (!importControl.current?.canAcceptDrop()) return;
          event.preventDefault();
          importControl.current.acceptDrop(event.dataTransfer);
        }}
      >
        <div className="flex min-h-9 flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            className={cx(buttonClass("secondary", "sm"), "lg:hidden")}
          >
            <FolderIcon />
            Tree
          </button>
          {/* A lone root crumb would only repeat the title below it. */}
          {crumbs.length > 1 && (
            <nav aria-label="Breadcrumbs" className="min-w-0">
              <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-[13px] text-muted">
                {crumbs.map((crumb, index) => (
                  <li key={crumb.id} className="flex min-w-0 items-center gap-1">
                    {index > 0 && <ChevronRightIcon className="size-3 text-muted/60" />}
                    <Link
                      to={
                        index === crumbs.length - 1 && crumbKind === "file"
                          ? `/f/${crumb.id}`
                          : nodePath(snapshot.access, crumb.id, "directory")
                      }
                      className={cx(
                        "truncate px-1.5 py-0.5 transition-colors hover:bg-ink/5 hover:text-ink",
                        index === crumbs.length - 1 && "text-ink-soft",
                      )}
                    >
                      {crumb.name}
                    </Link>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {busy && !showPending && (
            <p role="status" className="ml-auto inline-flex items-center gap-2 text-[13px] text-muted">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-accent" />
              Updating…
            </p>
          )}
        </div>
        {showPending && pending && <PendingNode kind={pending.kind} name={pending.name} />}
        <div className={showPending ? "hidden" : "animate-enter"}>
          <div className="mt-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
            <div className="min-w-0 max-w-full">
              {eyebrow && <p className="eyebrow mb-2 text-muted">{eyebrow}</p>}
              <h1 className="break-words font-display text-4xl font-light leading-[1.05] tracking-tight sm:text-[2.75rem]">
                {selected}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canCreate && (
                <>
                  <button
                    type="button"
                    disabled={busy || recoveryPending}
                    onClick={() => startCreate("file")}
                    className={buttonClass("primary", "sm")}
                  >
                    <FilePlusIcon />
                    New File
                  </button>
                  <button
                    type="button"
                    disabled={busy || recoveryPending}
                    onClick={() => startCreate("directory")}
                    className={buttonClass("secondary", "sm")}
                  >
                    <FolderPlusIcon />
                    New folder
                  </button>
                </>
              )}
              {canShare && (
                <button
                  type="button"
                  aria-haspopup="dialog"
                  disabled={busy || recoveryPending || (kind === "file" && !fileReady)}
                  onClick={() => setShareOpen(true)}
                  className={buttonClass("secondary", "sm")}
                >
                  <ShareIcon />
                  Share
                </button>
              )}
              {kind === "file" && snapshot.file && (
                <button
                  type="button"
                  aria-expanded={publishOpen}
                  onClick={() => setPublishOpen((open) => !open)}
                  className={cx(buttonClass("secondary", "sm"), publishOpen && "border-ink/40 bg-ink/[0.04]")}
                >
                  <GlobeIcon />
                  {owner ? "Publish" : "Request publication"}
                </button>
              )}
            </div>
          </div>

          {canChangeStructure && (
            <div className="mt-4 flex flex-wrap items-center gap-1 border-y border-line py-1.5">
              <button type="button" disabled={structureBlocked} onClick={startRename} className={textButtonClass()}>
                <PencilIcon />
                Rename
              </button>
              <button
                type="button"
                disabled={structureBlocked}
                onClick={() => startStructural({ operation: "move" })}
                className={textButtonClass()}
              >
                <MoveIcon />
                Move
              </button>
              {(["up", "down"] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  disabled={
                    structureBlocked ||
                    position < 0 ||
                    (direction === "up" ? position === 0 : position === siblings.length - 1)
                  }
                  onClick={() => startStructural({ operation: "reorder", direction })}
                  className={textButtonClass()}
                >
                  {direction === "up" ? <ArrowUpIcon /> : <ArrowDownIcon />}
                  Move {direction}
                </button>
              ))}
              <button
                type="button"
                disabled={structureBlocked}
                onClick={() => startStructural({ operation: "delete" })}
                className={textButtonClass("danger")}
              >
                <TrashIcon />
                Delete
              </button>
              {kind === "file" && !fileReady && (
                <p role="status" className="ml-auto px-2 text-xs text-muted">
                  Save your draft before changing this File’s name or location, order, or deleting it.
                </p>
              )}
            </div>
          )}
          {recoveryPending && (
            <p role="status" className={cx(noticeClass("warning"), "mt-4")}>
              Confirm your saved recovery phrase and codes before creating Files.
            </p>
          )}
          {message && (
            <p role="alert" className={cx(noticeClass("danger"), "mt-4")}>
              {message}
            </p>
          )}
          {kind === "file" && snapshot.file && publishOpen && publicationLifecycle && (
            <PublishPanel lifecycle={publicationLifecycle} fileReady={fileReady && !busy} />
          )}
          {kind === "file" ? (
            <>
              <div className="mt-6 inline-flex max-w-full flex-wrap border border-line bg-sand lg:hidden">
                {(
                  [
                    ["edit", "Edit", () => setView("edit")],
                    ["preview", "Preview", () => setView("preview")],
                    ["comments", "Comments", () => setView("comments")],
                  ] as const
                ).map(([value, label, show]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={show}
                    aria-pressed={view === value}
                    className="eyebrow px-4 py-2.5 text-ink-soft transition-colors hover:bg-paper aria-pressed:bg-ink aria-pressed:text-paper"
                  >
                    {label}
                  </button>
                ))}
              </div>
              {editorParent === snapshot.file?.parentId ? (
                <FileEditor
                  key={`${nodeId}/${snapshot.file?.parentId}`}
                  fileId={nodeId}
                  snapshot={snapshot}
                  view={view}
                  showEdit={() => setView("edit")}
                  onShowPreview={() => setView("preview")}
                  onShowComments={() => setView("comments")}
                  onStructuralReady={setStructuralReady}
                  structuralBusy={busy || dialog !== null}
                  onNavigationStart={onNavigationStart}
                  onCurrent={(file, listing) =>
                    setSnapshot(
                      (previous) =>
                        previous && {
                          ...previous,
                          file,
                          listings: listing
                            ? { ...previous.listings, [listing.directoryId]: listing }
                            : previous.listings,
                        },
                    )
                  }
                />
              ) : (
                <p role="status" className="mt-6 text-sm text-muted">
                  Opening moved File…
                </p>
              )}
            </>
          ) : (
            <FolderContents
              entries={folderEntries}
              canCreate={canCreate}
              access={snapshot.access}
              arrivingId={pending?.nodeId}
            />
          )}
          <div className="mt-12 grid divide-y divide-line border border-line md:grid-cols-2 md:divide-x md:divide-y-0">
            <ExportControl snapshot={snapshot} nodeId={nodeId} kind={kind} />
            <ImportControl
              ref={importControl}
              snapshot={snapshot}
              nodeId={nodeId}
              kind={kind}
              disabled={busy || recoveryPending}
              onRefresh={() => void revalidator.revalidate()}
            />
          </div>
        </div>
      </section>
      {shareOpen && canShare && (
        <ShareDialog
          target={{
            access: snapshot.access,
            nodeId,
            kind,
            file: snapshot.file,
            parent:
              shareParentId && snapshot.listings[shareParentId] && snapshot.keys[shareParentId]
                ? { listing: snapshot.listings[shareParentId], key: snapshot.keys[shareParentId] }
                : null,
            ancestors: snapshot.crumbs.slice(0, -1),
          }}
          onClose={() => setShareOpen(false)}
          onConverted={() => {
            // Only while this File is still the page: a stale pre-conversion
            // snapshot must not outlive the dialog, but another route is not ours.
            if (route.current === `${kind}/${nodeId}`) void revalidator.revalidate();
          }}
        />
      )}
      {dialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={dialogLabels[dialog.operation].label}
          className="modal-backdrop z-[70]"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(dialog);
            }}
            className="modal-panel max-w-md"
          >
            <p className="eyebrow text-accent">{kindName(dialog.kind, "start")}</p>
            <h2 className="mt-2 font-display text-3xl font-light leading-tight tracking-tight">
              {dialog.operation === "create" ? `New ${kindName(dialog.kind)}` : dialogLabels[dialog.operation].heading}
            </h2>
            {!["delete", "reorder"].includes(dialog.operation) && (
              <label className={cx(labelClass, "mt-5")}>
                Name{" "}
                <input
                  ref={nameInput}
                  // biome-ignore lint/a11y/noAutofocus: the rename/create dialog opens on an explicit user action; focus starts in its only field.
                  autoFocus
                  value={dialog.requestedName}
                  disabled={busy}
                  onChange={(event) => setDialog({ ...dialog, requestedName: event.target.value, review: undefined })}
                  className={cx(fieldClass(), "mt-2")}
                  placeholder={dialog.kind === "file" ? "Untitled.md" : "Untitled folder"}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            )}
            {dialog.operation === "move" && (
              <section aria-label="Destination folder" className="mt-5">
                <p className="text-sm text-ink-soft">
                  Destination: <span className="font-medium text-ink">{dialog.path.at(-1)?.name}</span>
                </p>
                <nav
                  aria-label="Destination breadcrumbs"
                  className="mt-2 flex flex-wrap items-center gap-1 text-[13px]"
                >
                  {dialog.path.map((folder, index) => (
                    <span key={folder.id} className="flex items-center gap-1">
                      {index > 0 && <ChevronRightIcon className="size-3 text-muted/60" />}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setDialog({
                            ...dialog,
                            destinationId: folder.id,
                            path: dialog.path.slice(0, index + 1),
                            review: undefined,
                          })
                        }
                        className="px-1.5 py-0.5 text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink"
                      >
                        {folder.name}
                      </button>
                    </span>
                  ))}
                </nav>
                <div className="mt-3 flex max-h-56 flex-col items-stretch divide-y divide-line overflow-y-auto border border-line bg-cream">
                  {snapshot.listings[dialog.destinationId]?.entries
                    .filter((entry) => entry.kind === "directory" && entry.nodeId !== nodeId)
                    .map((entry) => (
                      <button
                        key={entry.nodeId}
                        type="button"
                        disabled={busy}
                        onClick={() => void chooseFolder(entry)}
                        aria-label={`Open destination ${entry.name}`}
                        className="flex min-w-0 items-center gap-2 px-3 py-3 text-left text-sm text-ink-soft transition-colors hover:bg-paper hover:text-ink"
                      >
                        <FolderIcon className="text-accent/80" />
                        <span className="truncate">{entry.name}</span>
                        <ChevronRightIcon className="ml-auto size-3.5 text-muted" />
                      </button>
                    ))}
                  {!snapshot.listings[dialog.destinationId]?.entries.some(
                    (entry) => entry.kind === "directory" && entry.nodeId !== nodeId,
                  ) && <p className="px-3 py-2 text-sm text-muted">No folders inside.</p>}
                </div>
                {dialog.destinationId === dialog.parentId && (
                  <p className="mt-2 text-sm text-muted">Select a different folder.</p>
                )}
              </section>
            )}
            {dialog.operation === "delete" && (
              <div className="mt-4 space-y-3 text-sm leading-relaxed text-ink-soft">
                <p>
                  Permanently delete {dialog.requestedName}
                  {kind === "directory" ? " and all its descendants" : ""}? There is no trash or restore. This cannot
                  recall downloads or guarantee when provider-managed backups are erased.
                </p>
                <p>Folders can only be deleted whole when they contain at most 500 nodes.</p>
                {dialog.tooLarge ? (
                  <p role="alert" className={noticeClass("danger")}>
                    This folder contains more than 500 nodes. Reduce the subtree by moving or deleting smaller folders
                    or Files first. Nothing was deleted.
                  </p>
                ) : (
                  <label className="flex items-start gap-3 border border-danger/25 bg-danger-soft/60 px-4 py-3 text-ink">
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      checked={dialog.consent ?? false}
                      disabled={busy || !!dialog.review}
                      onChange={(event) => setDialog({ ...dialog, consent: event.target.checked })}
                    />{" "}
                    I understand deletion is irreversible.
                  </label>
                )}
              </div>
            )}
            {dialog.review === "local" && (
              <p role="alert" className={cx(noticeClass("warning"), "mt-4")}>
                That name is already in this folder. Choose another name; nothing was overwritten.
              </p>
            )}
            {dialog.review === "changed" && (
              <p role="alert" className={cx(noticeClass("warning"), "mt-4")}>
                This folder changed on another device. Nothing was added, replaced, or overwritten.
              </p>
            )}
            <div className="mt-7 flex flex-wrap justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setDialog(null)} className={buttonClass("ghost")}>
                Cancel
              </button>
              {dialog.review === "changed" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void refreshAndRetry(dialog)}
                  className={buttonClass("secondary")}
                >
                  Refresh and retry
                </button>
              )}
              {dialog.review && !["delete", "reorder"].includes(dialog.operation) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDialog({ ...dialog, review: undefined, needsRefresh: true });
                    nameInput.current?.focus();
                  }}
                  className={buttonClass("secondary")}
                >
                  Rename
                </button>
              )}
              {!dialog.review && !(dialog.operation === "delete" && dialog.tooLarge) && (
                <button
                  type="submit"
                  disabled={
                    busy ||
                    (dialog.operation === "delete" && !dialog.consent) ||
                    (dialog.operation === "move" && dialog.destinationId === dialog.parentId)
                  }
                  className={buttonClass(dialog.operation === "delete" ? "danger" : "primary")}
                >
                  {submitting ? "Working…" : dialogLabels[dialog.operation].submit}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="container-page flex min-h-[calc(100dvh-4rem)] animate-fade flex-col items-center justify-center py-20 text-center">
      <span className="grid size-14 place-items-center border border-line bg-cream">
        <Icon className="size-6 text-muted" />
      </span>
      {title && <h1 className="mt-6 font-display text-5xl font-light leading-tight tracking-tight">{title}</h1>}
      <div className={cx("max-w-md text-ink-soft", title ? "mt-3" : "mt-6")}>{children}</div>
    </main>
  );
}

/** The selected folder's own entries, so its contents are one tap away on every screen size. */
function FolderContents({
  entries,
  canCreate,
  access,
  arrivingId,
}: {
  entries: TreeEntry[];
  canCreate: boolean;
  access: FilesSnapshot["access"];
  arrivingId: string | undefined;
}) {
  if (!entries.length)
    return (
      <div className="mt-8 flex flex-col items-center border border-line px-6 py-16 text-center">
        <span className="grid size-12 place-items-center border border-line bg-cream">
          <FolderIcon className="size-5 text-muted" />
        </span>
        <p className="mt-4 font-display text-2xl font-light tracking-tight">This folder is empty</p>
        <p className="mt-2 max-w-sm text-sm text-ink-soft">
          {canCreate
            ? "Create a File or a folder, or drop Markdown here to import it."
            : "Nothing has been added here yet."}
        </p>
      </div>
    );
  return (
    <ul aria-label="Folder contents" className="mt-8 divide-y divide-line border-y border-ink">
      {entries.map((entry, index) => (
        <li key={entry.nodeId} className="animate-enter stagger" style={{ "--stagger": index } as CSSProperties}>
          <Link
            to={nodePath(access, entry.nodeId, entry.kind)}
            aria-label={`${entry.name}, ${entry.kind === "directory" ? "folder" : "File"}`}
            className={cx(
              "group flex min-w-0 items-center gap-3 px-2 py-3.5 transition-colors hover:bg-cream sm:gap-4 sm:px-4",
              arrivingId === entry.nodeId && "bg-cream",
            )}
          >
            <span className="grid size-10 shrink-0 place-items-center border border-line bg-cream text-ink-soft">
              {entry.kind === "directory" ? <FolderIcon className="size-5" /> : <FileIcon className="size-5" />}
            </span>
            <span className="min-w-0 flex-1 truncate font-display text-xl font-light tracking-tight text-ink">
              {entry.name}
            </span>
            <ChevronRightIcon className="size-4 text-muted transition-colors group-hover:text-ink" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * A workspace destination's frame while its verified walk runs: the name this
 * page already knows and placeholders shaped like the content it will show.
 */
function PendingNode({ kind, name }: { kind: TreeKind; name: string | null }) {
  return (
    <div className="animate-fade">
      <p role="status" className="sr-only">
        Opening {name ?? kindName(kind)}…
      </p>
      <div aria-hidden="true">
        <div className="mt-5">
          <p className="eyebrow mb-2 text-muted">{kind === "file" ? "Markdown" : "Folder"}</p>
          {name ? (
            <p className="truncate font-display text-4xl font-light leading-[1.05] tracking-tight text-ink sm:text-[2.75rem]">
              {name}
            </p>
          ) : (
            <div className="skeleton h-10 w-2/3 max-w-md sm:h-11" />
          )}
        </div>
        {kind === "file" ? (
          <>
            <div className="mt-8 flex items-center justify-between gap-4">
              <div className="skeleton h-3 w-44 max-sm:hidden" />
              <div className="skeleton ml-auto h-7 w-20" />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:gap-5">
              {["source", "preview"].map((pane) => (
                <div key={pane} className={cx("border border-line bg-cream", pane === "preview" && "max-lg:hidden")}>
                  <div className="flex min-h-12 items-center border-b border-line px-5">
                    <div className="skeleton h-3 w-28" />
                  </div>
                  <div className="h-[62vh] min-h-[22rem] px-5 py-5">
                    <SkeletonLines lines={5} />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <ul className="mt-8 divide-y divide-line border-y border-ink">
            {[64, 48, 56].map((width) => (
              <li key={width} className="flex items-center gap-3 px-2 py-3.5 sm:gap-4 sm:px-4">
                <span className="skeleton size-10 shrink-0" />
                <span className="skeleton h-5" style={{ width: `${width}%` }} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
