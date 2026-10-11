import { SkeletonLines } from "~/ui/page-layouts";

/**
 * The Files workspace before its browser-only loader finishes: the same frame
 * as the loaded page, so hydration fills it in rather than replacing it.
 */
export function FilesFallback() {
  return (
    <main
      aria-busy="true"
      className="w-full lg:grid lg:min-h-[calc(100dvh-4rem)] lg:grid-cols-[17.5rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)]"
    >
      <div className="hidden border-r border-line bg-sand px-6 py-8 lg:block">
        <div className="skeleton h-7 w-24" />
        <SkeletonLines lines={6} className="mt-6" />
      </div>
      <div className="px-4 pt-5 pb-16 sm:px-6 lg:px-10 lg:pt-8">
        <p role="status" className="text-[13px] text-muted">
          Opening Files…
        </p>
        <div className="skeleton mt-6 h-11 w-2/3 max-w-md" />
        <div className="mt-8 grid gap-4 lg:grid-cols-2 lg:gap-5">
          <div className="skeleton h-[50vh]" />
          <div className="skeleton hidden h-[50vh] lg:block" />
        </div>
      </div>
    </main>
  );
}
