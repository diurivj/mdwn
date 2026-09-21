import { runBrowserVector } from "./browser-test";
import type { BrowserVectorResult } from "./browser-test";

const target = document.querySelector<HTMLElement>("[data-testid=enc-v1-browser-result]");
if (!target) throw new Error("enc-v1 browser vector target is missing");

type WindowWithVector = Window & {
  __mdwnEncV1BrowserVector?: (result: BrowserVectorResult) => void;
};

void runBrowserVector()
  .then((result) => {
    target.textContent = JSON.stringify(result);
    (window as WindowWithVector).__mdwnEncV1BrowserVector?.(result);
  })
  .catch((error: unknown) => {
    target.textContent = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  });
