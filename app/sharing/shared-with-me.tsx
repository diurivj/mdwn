import { useEffect, useState } from "react";
import { Link } from "react-router";
import { type SharedWithMe, sharedWithMe } from "~/shared/sharing/shared-with-me-cache";
import { sharedRootName, sharedTargetPath } from "~/tree/navigation-client";
import { ShareIcon } from "~/ui/icons";
import { permissionLabel } from "./sharing-management";

/** Beyond this many roots the sidebar points to the Sharing page. */
const SIDEBAR_ROOTS = 50;
/** Returning to the tab refreshes a summary older than this. */
const FOCUS_AGE = 5_000;

/**
 * The library sidebar's received Grant roots and pending invitation count.
 * Data is browser-only, read through the tab-memory summary so remounting
 * Files routes does not list relationships again. It renders nothing until
 * there is something to show, and nothing on failure.
 */
export function SharedWithMeSection({ accountId, currentId }: { accountId: string; currentId: string }) {
  const [summary, setSummary] = useState<SharedWithMe | null>(() => sharedWithMe.peek(accountId));
  useEffect(() => {
    let live = true;
    const refresh = (maxAge?: number) => {
      sharedWithMe.read(accountId, { maxAge }).then(
        (value) => {
          if (live) setSummary(value);
        },
        () => {
          /* Unavailable sharing never blocks the library. */
        },
      );
    };
    refresh();
    const focused = () => refresh(FOCUS_AGE);
    window.addEventListener("focus", focused);
    return () => {
      live = false;
      window.removeEventListener("focus", focused);
    };
  }, [accountId]);
  if (!summary || summary.accountId !== accountId || (!summary.received.length && !summary.invitations)) return null;
  const { received, invitations } = summary;
  return (
    <section aria-label="Shared with me" className="border-t border-line px-3 py-4 text-sm lg:px-4">
      <h2 className="eyebrow px-2 text-muted">Shared with me</h2>
      {invitations > 0 && (
        <Link
          to="/account/sharing"
          className="mt-2 flex items-center gap-2 px-2 py-1.5 text-ink transition-colors hover:bg-paper"
        >
          <ShareIcon className="text-accent" />
          {invitations === 1 ? "1 invitation" : `${invitations} invitations`}
        </Link>
      )}
      {received.length > 0 && (
        <ul className="mt-2 space-y-px">
          {received.slice(0, SIDEBAR_ROOTS).map((grant) => (
            <li key={grant.grantId}>
              <Link
                to={sharedTargetPath(grant.targetId, grant.targetKind)}
                aria-current={grant.targetId === currentId ? "page" : undefined}
                className="flex items-baseline justify-between gap-3 px-2 py-1.5 text-ink-soft transition-colors hover:bg-paper hover:text-ink aria-[current=page]:bg-paper aria-[current=page]:text-ink"
              >
                <span>{sharedRootName(grant.targetKind)}</span>
                <span className="text-[12px] text-muted">{permissionLabel(grant.permission)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {received.length > SIDEBAR_ROOTS && (
        <Link to="/account/sharing" className="mt-1 block px-2 py-1.5 text-ink-soft hover:text-ink">
          View all on Sharing
        </Link>
      )}
    </section>
  );
}
