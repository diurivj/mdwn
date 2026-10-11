import { useMatches } from "react-router";

/**
 * Which site chrome a route renders inside, declared as `handle.chrome`:
 * - `site`: public pages with the marketing header and the footer (default);
 * - `account`: Account and device pages, whose header starts on app navigation;
 * - `workspace`: the full-height Files workspace, without a footer;
 * - `reader`: Public pages, with no site navigation at all.
 */
export type Chrome = "site" | "account" | "workspace" | "reader";
export type ChromeHandle = { chrome: Chrome };

export function useChrome(): Chrome {
  const matches = useMatches();
  for (let index = matches.length - 1; index >= 0; index--) {
    const chrome = (matches[index]!.handle as Partial<ChromeHandle> | undefined)?.chrome;
    if (chrome) return chrome;
  }
  return "site";
}
