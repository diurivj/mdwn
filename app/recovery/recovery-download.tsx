import { DownloadIcon } from "~/ui/icons";
import { buttonClass } from "~/ui/styles";

/** Saves `text` as a plain-text download from this browser. */
export function RecoveryDownload({ filename, text, label }: { filename: string; text: string; label: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return (
    <button type="button" onClick={download} className={buttonClass("secondary", "sm")}>
      <DownloadIcon />
      {label}
    </button>
  );
}
