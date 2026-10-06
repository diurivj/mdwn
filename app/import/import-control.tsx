/**
 * Files-chrome Import command and review (ticket 29).
 *
 * The command, a valid drop, and the two file inputs all open the same local
 * preflight: normalize the selection, allocate collision choices, display the
 * settled review (counts, sizes, target, ownership, every generated Keep-both
 * name), then measure the complete encrypted record/chunk plan. Nothing is
 * uploaded; confirmation is the boundary where ticket 30's staging protocol
 * takes over.
 */

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";

import { isSignupRecoveryConfirmationPending } from "~/shared/signup/recovery-gate";
import type { FilesSnapshot } from "~/tree/navigation-client";
import type { TreeKind } from "~/shared/tree/client";
import { importSigners, inputsFromDataTransfer, inputsFromFiles, loadReplacementDocuments } from "../shared/import/browser";
import { IMPORT_LIMITS, ImportError, formatBytes, importProblemMessage } from "../shared/import/limits";
import { prepareImportPlan, type ImportPlan } from "../shared/import/plan";
import { cancelImport, commitImport, openImportSession, uploadImportChunks, type ImportUploadProgress } from "../shared/import/staging-client";
import {
  canReplace, reviewImport, type ImportChoice, type ImportReview, type ImportReviewNode,
} from "../shared/import/review";
import { analyzeImportSelection, type ImportSource, type ImportSourceChild, type ImportSourceFile, type RawImportInput } from "../shared/import/source";
import { eligibleImportTargets, preferredImportTarget, type EligibleImportTarget } from "../shared/import/targets";

export type ImportControlHandle = {
  canAcceptDrop: () => boolean;
  acceptDrop: (dataTransfer: DataTransfer) => void;
};

type ImportControlProps = {
  snapshot: FilesSnapshot;
  nodeId: string;
  kind: TreeKind;
  /** Busy or recovery-confirmation-pending; Import must stay closed. */
  disabled: boolean;
  /** Called once an Import commit becomes visible, so the page refreshes. */
  onImported?: () => void;
};

type Phase =
  | { status: "idle" }
  | { status: "choosing"; inputs: RawImportInput[]; message: string }
  | { status: "preparing"; label: string }
  | { status: "review"; inputs: RawImportInput[]; source: ImportSource; choices: Record<string, ImportChoice>; targetId: string }
  | { status: "uploading"; plan: ImportPlan; progress: ImportUploadProgress }
  | { status: "done"; created: number; comments: number; entriesRevision?: number }
  | { status: "error"; message: string; inputs: RawImportInput[] | null };

function collectSourceFiles(children: readonly ImportSourceChild[], files: Map<string, ImportSourceFile>): void {
  for (const child of children) {
    if (child.kind === "file") files.set(child.path.join("/"), child);
    else collectSourceFiles(child.children, files);
  }
}

function blockedMessage(node: ImportReviewNode): string {
  switch (node.blocked) {
    case "over_limit": return importProblemMessage(new ImportError("generated-name-invalid", { item: node.displayPath.join("/") }));
    case "name_in_use": return importProblemMessage(new ImportError("name-in-use", { item: node.displayPath.join("/") }));
    case "cannot_replace": return "Only an existing File can be replaced by a File candidate. Choose Keep both, Skip, or Rename for this folder.";
    case "invalid_name": return "That name cannot be used in the destination folder.";
    case "parent_skipped": return "This item is inside a skipped folder, so it will not be imported.";
    case "parent_blocked": return "This item is inside a folder that needs a choice above.";
    default: return "This item needs a choice before the import can continue.";
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof ImportError) return importProblemMessage(error);
  return "The selection could not be reviewed. Nothing was uploaded; you can try again.";
}

export const ImportControl = forwardRef<ImportControlHandle, ImportControlProps>(function ImportControl(
  { snapshot, nodeId, kind, disabled, onImported }, ref,
) {
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const importAbort = useRef<AbortController | null>(null);
  const targets = useMemo(() => eligibleImportTargets(snapshot), [snapshot]);
  const targetsById = useMemo(() => new Map(targets.map((target) => [target.directoryId, target])), [targets]);
  const recoveryPending = isSignupRecoveryConfirmationPending();

  const review = useMemo(() => {
    if (phase.status !== "review") return null;
    const target = targetsById.get(phase.targetId);
    if (!target) return null;
    return reviewImport(phase.source, target, phase.choices);
  }, [phase, targetsById]);

  function openReview(inputs: RawImportInput[], targetId: string): void {
    setPhase({ status: "preparing", label: "Reviewing selection…" });
    void analyzeImportSelection(inputs).then((source) => {
      setPhase({ status: "review", inputs, source, choices: {}, targetId });
    }, (error: unknown) => {
      setPhase({ status: "error", message: failureMessage(error), inputs });
    });
  }

  function beginSelection(inputs: RawImportInput[]): void {
    if (disabled || recoveryPending || !inputs.length) return;
    const preferred = preferredImportTarget(snapshot, nodeId, kind);
    if (preferred) { openReview(inputs, preferred.directoryId); return; }
    setPhase({
      status: "choosing",
      inputs,
      message: targets.length
        ? "Choose a folder where you can add Files. New items go directly into that folder."
        : "This context has no folder you can add Files to. Open your own Files or a folder shared with you for editing, then try again.",
    });
  }

  async function beginDataTransfer(dataTransfer: DataTransfer): Promise<void> {
    if (disabled || recoveryPending) return;
    try {
      beginSelection(await inputsFromDataTransfer(dataTransfer));
    } catch (error) {
      setPhase({ status: "error", message: failureMessage(error), inputs: null });
    }
  }

  useImperativeHandle(ref, () => ({
    canAcceptDrop: () => !disabled && !recoveryPending && phase.status === "idle",
    acceptDrop: (dataTransfer: DataTransfer) => { void beginDataTransfer(dataTransfer); },
  }), [disabled, recoveryPending, phase.status]);

  async function runImport(plan: ImportPlan): Promise<void> {
    const controller = new AbortController();
    importAbort.current = controller;
    setPhase({ status: "uploading", plan, progress: { chunksSent: 0, chunksTotal: plan.chunks.length } });
    let importId: string | null = null;
    try {
      importId = await openImportSession(plan, controller.signal);
      await uploadImportChunks(plan, importId, (progress) => setPhase((previous) =>
        previous.status === "uploading" ? { ...previous, progress } : previous), controller.signal);
      const result = await commitImport(importId, controller.signal);
      importId = null;
      setPhase({ status: "done",
        created: plan.review.counts.createFiles + plan.review.counts.createDirectories + plan.review.counts.replaces,
        comments: plan.review.counts.comments, entriesRevision: result.entriesRevision });
      onImported?.();
    } catch (error) {
      if (importId) await cancelImport(importId);
      if (controller.signal.aborted) { setPhase({ status: "idle" }); return; }
      setPhase({ status: "error", message: failureMessage(error), inputs: null });
    } finally {
      importAbort.current = null;
    }
  }

  function cancelUpload(): void {
    importAbort.current?.abort();
  }

  async function confirm(current: ImportReview, source: ImportSource): Promise<void> {
    const target = targetsById.get(current.target.directoryId);
    if (!target || !current.canConfirm) return;
    setPhase({ status: "preparing", label: "Measuring the encrypted plan…" });
    try {
      const files = new Map<string, ImportSourceFile>();
      collectSourceFiles(source.roots, files);
      const replacements = await loadReplacementDocuments(snapshot.access, target.key, current);
      const signers = await importSigners(snapshot.access);
      const plan = await prepareImportPlan({
        review: current,
        files,
        comments: source.comments,
        targetKey: target.key,
        replacements,
        ...signers,
      });
      await runImport(plan);
    } catch (error) {
      setPhase({ status: "error", message: failureMessage(error), inputs: null });
    }
  }

  function reset(): void {
    setPhase({ status: "idle" });
    if (fileInput.current) fileInput.current.value = "";
    if (folderInput.current) folderInput.current.value = "";
  }

  async function onFilesChosen(input: HTMLInputElement | null): Promise<void> {
    const files = input?.files;
    if (!input || !files?.length) return;
    const chosen = Array.from(files);
    input.value = "";
    try {
      beginSelection(await inputsFromFiles(chosen));
    } catch (error) {
      setPhase({ status: "error", message: failureMessage(error), inputs: null });
    }
  }

  const dialogOpen = phase.status !== "idle";
  return <>
    <div className="flex flex-wrap items-center gap-2 rounded border border-stone-200 bg-stone-50 px-2 py-1" data-testid="import-control">
      <span className="text-sm font-medium">Import</span>
      <button type="button" disabled={disabled || recoveryPending} onClick={() => fileInput.current?.click()}
        className="rounded border px-2 py-1" data-testid="import-files-command">Import Files</button>
      <button type="button" disabled={disabled || recoveryPending} onClick={() => folderInput.current?.click()}
        className="rounded border px-2 py-1" data-testid="import-folder-command">Import folder</button>
      <span className="basis-full text-xs text-stone-500">Drop Markdown Files or folders on this page. Nothing is uploaded until you confirm the review.</span>
      <input ref={fileInput} type="file" multiple accept=".md,.markdown,text/markdown,.zip,application/zip" className="hidden"
        data-testid="import-files-input" onChange={(event) => void onFilesChosen(event.currentTarget)} />
      <input ref={(element) => { if (element) { element.setAttribute("webkitdirectory", ""); element.setAttribute("directory", ""); } }}
        type="file" className="hidden" data-testid="import-folder-input"
        onChange={(event) => void onFilesChosen(event.currentTarget)} />
    </div>
    {dialogOpen && <div role="dialog" aria-modal="true" aria-label="Import review" data-testid="import-dialog"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded bg-white p-5 shadow-lg">
        {phase.status === "choosing" && <>
          <h2 className="text-lg font-semibold">Choose an Import folder</h2>
          <p className="mt-2" role="alert">{phase.message}</p>
          {targets.length > 0 && <ul className="mt-3 space-y-2">
            {targets.map((target) => <li key={target.directoryId}>
              <button type="button" className="rounded border px-3 py-1" data-testid={`import-target-${target.directoryId}`}
                onClick={() => openReview(phase.inputs, target.directoryId)}>{target.label}</button>
            </li>)}
          </ul>}
          <div className="mt-5 flex justify-end"><button type="button" className="rounded border px-3 py-1" onClick={reset}>Cancel</button></div>
        </>}
        {phase.status === "preparing" && <p role="status" data-testid="import-preparing">{phase.label}</p>}
        {phase.status === "error" && <>
          <h2 className="text-lg font-semibold">Import review</h2>
          <p className="mt-2 text-rose-700" role="alert" data-testid="import-error">{phase.message}</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="rounded border px-3 py-1" onClick={reset}>Close</button>
            {phase.inputs && <button type="button" className="rounded border px-3 py-1"
              onClick={() => beginSelection(phase.inputs!)}>Try again</button>}
          </div>
        </>}
        {phase.status === "review" && review && <>
          <h2 className="text-lg font-semibold">Import review</h2>
          <ReviewSummary review={review} />
          <CollisionChoices review={review} onChoose={(sourcePath, choice) => setPhase((previous) =>
            previous.status === "review" ? { ...previous, choices: { ...previous.choices, [sourcePath]: choice } } : previous)} />
          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-xs text-stone-500" data-testid="import-no-upload">Nothing is uploaded until you confirm this review.</p>
            <button type="button" className="rounded border px-3 py-1" onClick={reset}>Cancel</button>
            <button type="button" className="rounded bg-stone-900 px-3 py-1 text-white disabled:opacity-50"
              disabled={!review.canConfirm} onClick={() => void confirm(review, phase.source)} data-testid="import-confirm">
              {review.empty ? "Nothing to import" : "Import"}
            </button>
          </div>
        </>}
        {phase.status === "uploading" && <>
          <h2 className="text-lg font-semibold">Importing</h2>
          <p className="mt-2 text-sm" role="status" data-testid="import-uploading">
            Uploading encrypted chunks {phase.progress.chunksSent} of {phase.progress.chunksTotal}… Nothing is visible until the final commit.
          </p>
          <div className="mt-5 flex justify-end">
            <button type="button" className="rounded border px-3 py-1" onClick={cancelUpload}
              data-testid="import-cancel-upload">Cancel Import</button>
          </div>
        </>}
        {phase.status === "done" && <>
          <h2 className="text-lg font-semibold">Import complete</h2>
          <p className="mt-2 text-sm" role="status" data-testid="import-complete">
            Added {phase.created} {phase.created === 1 ? "item" : "items"}{phase.comments > 0
              ? ` with ${phase.comments} Historical ${phase.comments === 1 ? "Comment" : "Comments"}` : ""}. The folder now shows the whole import.
          </p>
          <div className="mt-5 flex justify-end">
            <button type="button" className="rounded border px-3 py-1" onClick={reset}
              data-testid="import-done">Close</button>
          </div>
        </>}
      </div>
    </div>}
  </>;
});

function ReviewSummary({ review }: { review: ImportReview }) {
  const { counts } = review;
  const targetOwner = review.target.ownerAccountId !== review.target.actorAccountId;
  return <>
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm" data-testid="import-summary">
      <dt>Source items</dt><dd data-testid="import-summary-sources">{counts.sources}</dd>
      <dt>Create</dt><dd data-testid="import-summary-create">
        {counts.createFiles} {counts.createFiles === 1 ? "File" : "Files"}, {counts.createDirectories} {counts.createDirectories === 1 ? "folder" : "folders"}</dd>
      <dt>Replace</dt><dd data-testid="import-summary-replace">{counts.replaces}</dd>
      <dt>Skip</dt><dd data-testid="import-summary-skip">{counts.skips}</dd>
      <dt>Maximum folder depth</dt><dd>{counts.maxDepth}</dd>
      <dt>Sizes</dt><dd>{counts.compressedBytes === null ? "—" : `${formatBytes(counts.compressedBytes)} compressed, `}{formatBytes(counts.expandedBytes)} expanded</dd>
      {counts.comments > 0 && <><dt>Historical Comments</dt><dd data-testid="import-summary-comments">{counts.comments}</dd></>}
    </dl>
    <p className="mt-3 text-sm" data-testid="import-target">Target: <strong>{review.target.label}</strong>
      {targetOwner && <> — you do not own this folder. New items will belong to its Owner’s Account and will not appear in your <strong>Export my Files</strong>.</>}
      {!targetOwner && <> — owned by you.</>}
    </p>
    {review.generatedNames.length > 0 && <section className="mt-3" aria-label="Generated Keep-both names" data-testid="import-generated-names">
      <h3 className="text-sm font-semibold">Keep-both names</h3>
      <ul className="mt-1 list-inside list-disc text-sm">
        {review.generatedNames.map((name) => <li key={name}>{name}</li>)}
      </ul>
    </section>}
    {review.empty && <p className="mt-3" role="alert">Every item is skipped, so nothing would be created.</p>}
  </>;
}

function CollisionChoices({ review, onChoose }: {
  review: ImportReview;
  onChoose: (sourcePath: string, choice: ImportChoice) => void;
}) {
  const collisions = review.nodes.filter((node) => node.collision && node.blocked !== "parent_skipped" &&
    node.blocked !== "parent_blocked");
  if (!collisions.length) return null;
  return <section className="mt-4" aria-label="Name conflicts">
    <h3 className="text-sm font-semibold">Name conflicts</h3>
    <ul className="mt-2 space-y-3">
      {collisions.map((node) => <li key={node.sourcePath} className="rounded border border-stone-200 p-2 text-sm" data-testid={`import-collision-${node.sourcePath}`}>
        <p><strong>{node.displayPath.join("/")}</strong> matches {node.collision!.existingKind === "file" ? "a File" : "a folder"} named{" "}
          <strong>{node.collision!.existingName}</strong>{node.collision!.sameSpelling ? "" : " (equivalent spelling)"}. Files treats case and equivalent Unicode spelling as the same name.</p>
        <label className="mt-1 flex flex-wrap items-center gap-2">
          Action
          <select className="rounded border p-1" value={node.choice?.action ?? "keep_both"}
            aria-label={`Action for ${node.displayPath.join("/")}`}
            onChange={(event) => {
              const action = event.target.value as ImportChoice["action"];
              if (action === "rename") onChoose(node.sourcePath, { action: "rename", name: node.requestedName });
              else if (action === "replace") onChoose(node.sourcePath, { action: "replace" });
              else if (action === "skip") onChoose(node.sourcePath, { action: "skip" });
              else onChoose(node.sourcePath, { action: "keep_both" });
            }}>
            <option value="keep_both" disabled={node.blocked === "over_limit"}>Keep both</option>
            <option value="skip">Skip</option>
            <option value="replace" disabled={!canReplace(node)}>Replace the existing File</option>
            <option value="rename">Rename</option>
          </select>
        </label>
        {node.choice?.action === "rename" && <input className="mt-1 w-full rounded border p-1" value={node.choice.name}
          aria-label={`New name for ${node.displayPath.join("/")}`}
          onChange={(event) => onChoose(node.sourcePath, { action: "rename", name: event.target.value })} />}
        {node.generated && <p className="mt-1 text-stone-600">Keep both creates <strong>{node.displayName}</strong>.</p>}
        {node.action === "replace" && <p className="mt-1 text-stone-600">Replaces the current contents, keeping the File’s comments and Publication.</p>}
        {node.action === "skip" && <p className="mt-1 text-stone-600">Skipped: nothing is created or replaced.</p>}
        {node.blocked && <p className="mt-1 text-rose-700" role="alert">{blockedMessage(node)}</p>}
      </li>)}
    </ul>
    <p className="mt-2 text-xs text-stone-500">Import accepts at most {IMPORT_LIMITS.maxNodes} items, {IMPORT_LIMITS.maxDepth} folder levels, and {formatBytes(IMPORT_LIMITS.maxExpandedBytes)} expanded.</p>
  </section>;
}

