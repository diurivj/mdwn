// Preload only for `playwright install` (including its downloader children).
// Playwright 1.63 waits >=5s before falling back from an unreachable IPv6 address.
// Node 24's HTTPS agent can time out at 5s before request.setTimeout(30s) takes
// effect on connect. Match Playwright's default budget during connection too.
// Keep TLS verification and IPv4/IPv6 selection unchanged. Remove this shim
// when a cold install succeeds without it on the runner's network.
import https from "node:https";

https.globalAgent.options.timeout = 30_000;
