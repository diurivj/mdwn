import { useEffect, useRef, useState } from "react";

import type { FilesSnapshot } from "~/tree/navigation-client";
import { downloadExport, exportOwnedFiles, type ExportSelection } from "./export-client";
import { ExportError } from "../shared/export/collect";
import { cx } from "~/ui/cx";
import { DownloadIcon } from "~/ui/icons";
import { buttonClass } from "~/ui/styles";

type ExportState =
  | { status: "idle" }
  | { status: "running"; files: number; directories: number }
  | { status: "done"; files: number; directories: number; comments: number; incomplete: number }
  | { status: "error"; message: string };

function failureMessage(error: unknown): string {
  if (error instanceof ExportError) {
    if (error.code === "not_owned") return "Only Files you own can be exported.";
    if (error.code === "too_deep") return "This folder hierarchy is too deep to export.";
    if (error.detail) return `“${error.detail}” cannot be represented in an mdwn archive. Rename it and try again.`;
    return "This selection cannot be represented in an mdwn archive.";
  }
  return "Export could not be completed. No content left this browser; you can try again.";
}

/**
 * Files-chrome Export command. It is available to the Owner only: shared
 * content reaches this component through a Grant, and its chrome never offers
 * an export. Nothing here consults Public-participation state, so a suspension
 * can never block an owned-Files export.
 */
export function ExportControl({
  snapshot,
  nodeId,
  kind,
}: {
  snapshot: FilesSnapshot;
  nodeId: string;
  kind: "file" | "directory";
}) {
  const [state, setState] = useState<ExportState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (snapshot.access.vaultId !== snapshot.access.actorAccountId) return null;
  const running = state.status === "running";
  const selectedName = snapshot.crumbs.at(-1)?.name ?? "Export";
  const parentId = kind === "file" ? snapshot.file?.parentId : undefined;
  const parentKey = parentId ? snapshot.keys[parentId] : undefined;
  const selectedKey = kind === "directory" ? snapshot.keys[nodeId] : undefined;
  const canExportSelected =
    nodeId !== snapshot.access.rootId && (kind === "file" ? Boolean(snapshot.file && parentKey) : Boolean(selectedKey));

  async function start(selection: ExportSelection) {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setState({ status: "running", files: 0, directories: 0 });
    try {
      const result = await exportOwnedFiles({
        selection,
        signal: abort.signal,
        onProgress: ({ files, directories }) => setState({ status: "running", files, directories }),
      });
      if (abort.signal.aborted) return;
      downloadExport(result);
      setState({
        status: "done",
        files: result.files,
        directories: result.directories,
        comments: result.comments,
        incomplete: result.incompleteCommentFiles,
      });
    } catch (error) {
      if (abort.signal.aborted) setState({ status: "idle" });
      else setState({ status: "error", message: failureMessage(error) });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 bg-sand p-5">
      <span className="eyebrow inline-flex items-center gap-2 text-muted">
        <DownloadIcon className="size-3.5 text-accent" />
        Export
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={running}
          onClick={() => void start({ kind: "all" })}
          className={buttonClass("secondary", "sm")}
        >
          Export my Files
        </button>
        {canExportSelected && (
          <button
            type="button"
            disabled={running}
            className={buttonClass("secondary", "sm")}
            onClick={() =>
              void start(
                kind === "file"
                  ? { kind: "file", fileId: nodeId, parentKey: parentKey!, name: selectedName }
                  : { kind: "directory", directoryId: nodeId, key: selectedKey!, name: selectedName },
              )
            }
          >
            {kind === "file" ? "Export this File" : "Export this folder"}
          </button>
        )}
        {running && (
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => controller.current?.abort()}>
            Cancel export
          </button>
        )}
      </div>
      {state.status === "running" && (
        <span role="status" className="text-sm text-ink-soft">
          {state.files ? `Exporting ${state.files} ${state.files === 1 ? "File" : "Files"}…` : "Preparing export…"}
        </span>
      )}
      {state.status === "done" && (
        <span role="status" className="text-sm text-success">
          Exported {state.files} {state.files === 1 ? "File" : "Files"} ({state.directories}{" "}
          {state.directories === 1 ? "folder" : "folders"}
          {state.comments ? `, ${state.comments} ${state.comments === 1 ? "Comment" : "Comments"}` : ""}).{" "}
          {state.incomplete > 0 &&
            `Comment history for ${state.incomplete} ${state.incomplete === 1 ? "File" : "Files"} could not be read on this device.`}
        </span>
      )}
      {state.status === "error" && (
        <span role="alert" className="text-sm text-danger">
          {state.message}
        </span>
      )}
      <span className={cx("text-xs leading-relaxed text-muted")}>
        Creates a ZIP only in this browser. It cannot remove or recall copies already downloaded elsewhere.
      </span>
    </div>
  );
}
