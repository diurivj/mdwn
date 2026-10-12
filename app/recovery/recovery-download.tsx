import { DownloadIcon } from "~/ui/icons";
import { saveFile } from "~/ui/save-file";
import { buttonClass } from "~/ui/styles";

/** Saves `text` as a plain-text download from this browser. */
export function RecoveryDownload({ filename, text, label }: { filename: string; text: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => saveFile(new Blob([text], { type: "text/plain;charset=utf-8" }), filename)}
      className={buttonClass("secondary", "sm")}
    >
      <DownloadIcon />
      {label}
    </button>
  );
}
