import type { ReactNode } from "react";

import { FilesFallback } from "~/tree/files-fallback";

import type { Chrome } from "./chrome";
import { ACCOUNT_NAV, AccountLayout, PageIntro, SkeletonLines } from "./page-layouts";
import { useDelayedFlag, usePendingLocation } from "./pending-navigation";

export type PendingPage = { chrome: Chrome; page: ReactNode };

/**
 * The destination's own layout while a navigation into the library or an
 * Account page runs its browser-only loader, in place of the page being left.
 * Navigations within the library preview themselves from the decrypted tree.
 */
export function usePendingPage(current: Chrome): PendingPage | null {
  const location = usePendingLocation();
  const placeholder = location ? placeholderFor(location.pathname, current) : null;
  return useDelayedFlag(placeholder !== null) ? placeholder : null;
}

function placeholderFor(pathname: string, current: Chrome): PendingPage | null {
  if (pathname === "/files" || /^\/[df]\/[^/]+$/.test(pathname))
    return current === "workspace" ? null : { chrome: "workspace", page: <FilesFallback /> };
  const destination = ACCOUNT_NAV.find((item) => item.to === pathname);
  if (!destination) return null;
  return {
    chrome: "account",
    page: (
      <AccountLayout busy pathname={pathname}>
        <PageIntro title={destination.label} />
        <SkeletonLines className="mt-10 max-w-xl" />
      </AccountLayout>
    ),
  };
}
