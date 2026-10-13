/** Compute overlap from half-open execution intervals, including failed jobs.
 * @param {Array<{started_at: string | null, completed_at: string | null, runner_id?: number}>} jobs
 */
export function executionIntervals(jobs) {
  const intervals = jobs.flatMap((job) => {
    // Canceled queued jobs receive creation-to-cancellation timestamps, but
    // runner_id=0 proves they were never assigned and executed no work.
    if (job.runner_id === 0) return [];
    const start = Date.parse(job.started_at ?? "");
    const end = Date.parse(job.completed_at ?? "");
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : [];
  });
  const events = intervals.flatMap(({ start, end }) => [
    [start, 1],
    [end, -1],
  ]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let maximum = 0;
  for (const [, delta] of events) {
    active += delta;
    maximum = Math.max(maximum, active);
  }
  return {
    maximumOverlap: maximum,
    firstStart: intervals.length ? Math.min(...intervals.map((interval) => interval.start)) : null,
    lastFinish: intervals.length ? Math.max(...intervals.map((interval) => interval.end)) : null,
  };
}

/** Workflow completion includes canceled waiting jobs, even without execution.
 * @param {Array<{completed_at: string | null}>} jobs
 */
export function lastJobCompletion(jobs) {
  const timestamps = jobs.map((job) => Date.parse(job.completed_at ?? "")).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

/** @param {any} report */
export function summarizePlaywright(report) {
  const counts = { tests: 0, retries: 0, flaky: 0, failed: 0, skipped: 0, timedOutAttempts: 0 };
  /** @param {any[]} suites */
  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          counts.tests++;
          counts.retries += (test.results ?? []).filter((/** @type {any} */ result) => result.retry > 0).length;
          counts.flaky += Number(test.status === "flaky");
          counts.failed += Number(test.status === "unexpected");
          counts.skipped += Number(test.status === "skipped");
          counts.timedOutAttempts += (test.results ?? []).filter(
            (/** @type {any} */ result) => result.status === "timedOut",
          ).length;
        }
      }
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites ?? []);
  return { ...counts, errors: (report.errors ?? []).length };
}
