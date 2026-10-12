import { expect, test } from "vitest";
import { executionIntervals, summarizePlaywright } from "../scripts/lib/ci-timing.mjs";

test("interval overlap distinguishes serialization, overlap, and an exact handoff", () => {
  const job = (start: number, end: number) => ({
    started_at: new Date(start * 1000).toISOString(),
    completed_at: new Date(end * 1000).toISOString(),
  });
  expect(executionIntervals([job(1, 4), job(4, 8)]).maximumOverlap).toBe(1);
  expect(executionIntervals([job(1, 6), job(2, 7), job(3, 8), job(4, 9)]).maximumOverlap).toBe(4);
  expect(executionIntervals([{ started_at: null, completed_at: null }])).toEqual({
    maximumOverlap: 0,
    firstStart: null,
    lastFinish: null,
  });
});

test("retry-recovered green tests retain their timeout and retry evidence", () => {
  const summary = summarizePlaywright({
    suites: [
      {
        suites: [
          {
            specs: [
              {
                tests: [
                  {
                    status: "flaky",
                    results: [
                      { retry: 0, status: "timedOut" },
                      { retry: 1, status: "passed" },
                    ],
                  },
                  {
                    status: "unexpected",
                    results: [
                      { retry: 0, status: "failed" },
                      { retry: 1, status: "failed" },
                    ],
                  },
                  { status: "skipped", results: [] },
                  { status: "expected", results: [{ retry: 0, status: "passed" }] },
                ],
              },
            ],
          },
        ],
      },
    ],
    errors: [],
  });
  expect(summary).toEqual({ tests: 4, retries: 2, flaky: 1, failed: 1, skipped: 1, timedOutAttempts: 1, errors: 0 });
});
