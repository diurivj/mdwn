import { useEffect, useState } from "react";

import { finishRecoveryProvisioning } from "./provision-client";

/** Continue a recovery job while its page remains open and hide status after completion. */
export function useRecoveryProvisioning(needed: boolean): boolean {
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (!needed) return;
    const controller = new AbortController();
    void finishRecoveryProvisioning(controller.signal).then(() => {
      if (!controller.signal.aborted) setFinished(true);
    });
    return () => controller.abort();
  }, [needed]);
  return needed && !finished;
}
