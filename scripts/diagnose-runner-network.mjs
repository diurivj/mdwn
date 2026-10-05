// Temporary CI probe; remove once the Mac mini download failure is diagnosed.
import https from "node:https";
import { spawnSync } from "node:child_process";

const prefix = "[DEBUG-mdwn-runner-network]";
const url = "https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip";
console.log(prefix, "runtime", process.version, process.platform, process.arch);
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS"]) {
  console.log(prefix, key, process.env[key] ? "set (value withheld)" : "unset");
}

for (const [name, flags] of [["curl-default", []], ["curl-ipv4", ["-4"]]]) {
  console.log(prefix, name);
  const result = spawnSync("curl", [
    ...flags, "--fail", "--location", "--range", "0-1023",
    "--connect-timeout", "8", "--max-time", "15", "--output", "/dev/null",
    "--silent", "--show-error", "--write-out",
    "HTTP %{http_code}; connect=%{time_connect}s; TLS=%{time_appconnect}s; total=%{time_total}s; bytes=%{size_download}\n", url,
  ], { encoding: "utf8", timeout: 20_000 });
  console.log(prefix, "exit", result.status, result.stdout.trim());
  // Do not print stderr: a proxy error could contain its configured address.
}

/** @param {string} name @param {number | undefined} family */
async function probeNode(name, family) {
  let target = new URL(url);
  for (let redirects = 0; redirects < 5; redirects++) {
    const started = performance.now();
    console.log(prefix, name, "host", target.hostname);
    const result = await new Promise((resolve) => {
      const request = https.get(target, { family, headers: { Range: "bytes=0-1023" } });
      const timer = setTimeout(() => request.destroy(Object.assign(new Error("probe timeout"), { code: "PROBE_TIMEOUT" })), 12_000);
      request.on("socket", (socket) => {
        for (const event of ["lookup", "connect", "secureConnect"]) {
          socket.once(event, () => console.log(prefix, name, event, `${Math.round(performance.now() - started)}ms`));
        }
      });
      request.on("response", (response) => {
        clearTimeout(timer);
        console.log(prefix, name, "HTTP", response.statusCode, `${Math.round(performance.now() - started)}ms`);
        resolve({ status: response.statusCode, location: response.headers.location });
        response.destroy();
      });
      request.on("error", (error) => {
        clearTimeout(timer);
        console.log(prefix, name, "error", "code" in error ? error.code : error.name, `${Math.round(performance.now() - started)}ms`);
        resolve({});
      });
    });
    if (!result.location || result.status < 300 || result.status >= 400) return;
    target = new URL(result.location, target);
    if (target.protocol !== "https:") return;
  }
}

await probeNode("node-default", undefined);
await probeNode("node-ipv4", 4);
