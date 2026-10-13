// Test-only subprocess boundary: never starts a real service or calls GitHub.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";

const root = process.env.MDWN_POOL_TEST_ROOT;
if (!root) throw new Error("Missing isolated pool test root");
os.userInfo = () => ({ username: "ci", homedir: root, uid: 501, gid: 20, shell: "/bin/sh" });
Object.defineProperty(process, "platform", { value: "darwin" });
Object.defineProperty(process, "arch", { value: "arm64" });

childProcess.execFileSync = (executable, args) => {
  appendFileSync(`${root}/commands.jsonl`, `${JSON.stringify({ executable, args })}\n`);
  if (executable === "/bin/ps")
    return process.env.MDWN_POOL_TEST_LOADED === "false" ? "" : `ci 100 1 ${root}/ci/runners/one/bin/Runner.Listener\n`;
  if (executable === "/usr/bin/dscl") return "ci 501\n";
  if (executable === "launchctl" || executable === "./svc.sh") return "";
  if (executable === "gh") {
    if (args.includes("POST")) return JSON.stringify({ labels: [{ name: "mini-m4pro-ci" }] });
    return JSON.stringify({
      id: 1,
      busy: process.env.MDWN_POOL_TEST_BUSY === "true",
      labels: [{ name: "mini-m4pro-ci" }],
    });
  }
  throw new Error(`Unmocked subprocess ${executable}`);
};
childProcess.spawnSync = (executable, args) => {
  if (executable !== "launchctl") throw new Error(`Unmocked subprocess ${executable}`);
  const loaded =
    (args[1] === "gui/501" && process.env.MDWN_POOL_TEST_LOADED !== "false") ||
    (args[1] === "user/501" && process.env.MDWN_POOL_TEST_DUAL_DOMAINS === "true");
  return {
    status: 0,
    stdout: loaded ? "services = {\n  100 - actions.runner.owner-repo.one\n}\n" : "services = {}\n",
    stderr: "",
  };
};
syncBuiltinESMExports();
