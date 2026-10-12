/**
 * Run `pass` now, or once more after the pass in flight, however many times
 * it is asked meanwhile. A pass that ends early or fails (a navigation abort,
 * for example) still runs the requested next one, which reads its own
 * current state, so a later page's request is never lost (ticket 57).
 */
export function coalescedRunner(pass: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await pass().catch(() => {});
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
