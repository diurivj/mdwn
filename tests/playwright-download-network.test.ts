import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the download-only preload gives Node's HTTPS agent Playwright's connection budget", () => {
  const preload = new URL("../scripts/playwright-download-network.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import https from "node:https";
    console.log(JSON.stringify(https.globalAgent.options.timeout));
  `], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}` },
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toBe(30_000);
});
