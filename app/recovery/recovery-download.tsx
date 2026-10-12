import { useEffect, useState } from "react";

import { gzip } from "~/shared/archive/gzip";
import { DownloadIcon } from "~/ui/icons";
import { saveFile } from "~/ui/save-file";
import { buttonClass } from "~/ui/styles";

const encoder = new TextEncoder();

/**
 * Saves `text` from this browser as `<name>.txt.gz`, a gzip-compressed text
 * file, with the same text as a plain `<name>.txt` for places that cannot open
 * `.gz` files. Both are made here and never sent anywhere.
 */
export function RecoveryDownload({ name, text, label }: { name: string; text: string; label: string }) {
  // Compressed before the click, so saving stays a direct response to it.
  // Null: this browser cannot compress, so the plain file is the only choice.
  const [compressed, setCompressed] = useState<Blob | null>();
  useEffect(() => {
    let current = true;
    setCompressed(undefined);
    void gzip(encoder.encode(text)).then((bytes) => {
      if (current) setCompressed(bytes && new Blob([bytes.slice()], { type: "application/gzip" }));
    });
    return () => {
      current = false;
    };
  }, [text]);
  const savePlain = () => saveFile(new Blob([text], { type: "text/plain;charset=utf-8" }), `${name}.txt`);
  if (compressed === null)
    return (
      <button type="button" onClick={savePlain} className={buttonClass("secondary", "sm")}>
        <DownloadIcon />
        {label} (.txt)
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-2">
      <button
        type="button"
        disabled={!compressed}
        onClick={() => compressed && saveFile(compressed, `${name}.txt.gz`)}
        className={buttonClass("secondary", "sm")}
      >
        <DownloadIcon />
        {label} (.txt.gz)
      </button>
      <button
        type="button"
        onClick={savePlain}
        aria-label={`${label} as plain text (.txt)`}
        className={buttonClass("ghost", "sm")}
      >
        Plain text (.txt)
      </button>
    </span>
  );
}
