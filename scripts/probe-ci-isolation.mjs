#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { join, resolve } from "node:path";
import { slotEnvironment, validatePool } from "./lib/runner-pool.mjs";

/** @param {string} directory @param {number} [depth] @returns {string[]} */
function sqliteFiles(directory, depth = 0) {
  if (depth > 8) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sqliteFiles(path, depth + 1)
      : entry.isFile() && /\.sqlite$/.test(entry.name)
        ? [path]
        : [];
  });
}

/** @param {number} pid @returns {number[]} */
function processFamily(pid) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  for (let previous = -1; previous !== owned.size; ) {
    previous = owned.size;
    for (const [child, parent] of rows) if (owned.has(parent)) owned.add(child);
  }
  return [...owned];
}

/** @param {number[]} pids */
function listeningSockets(pids) {
  const output = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fpn"], {
    encoding: "utf8",
  });
  let pid = 0;
  return output.split("\n").flatMap((line) => {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n")) return [];
    const address = line.slice(1);
    return [{ pid, address, port: Number(address.slice(address.lastIndexOf(":") + 1)) }];
  });
}

if (process.argv[2] === "--child") {
  const { createTestHarness } = await import("wrangler");
  const before = new Set(sqliteFiles(process.env.TMPDIR ?? ""));
  const config = JSON.parse(readFileSync("build/server/wrangler.json", "utf8"));
  const server = createTestHarness({
    root: "./build/server",
    workers: [
      {
        config: {
          ...config,
          dev: { ...config.dev, local_protocol: "https", upstream_protocol: "https" },
          vars: {
            ...config.vars,
            SESSION_COOKIE_SECRET: "ci-isolation-probe-only",
            ABUSE_HMAC_SECRET: "ci-isolation-probe-only",
          },
        },
      },
    ],
  });
  process.on("message", async (/** @type {any} */ message) => {
    try {
      /** @type {any} */
      let data = null;
      if (message.op === "seed") {
        const { url } = await server.listen();
        const env = await server.getWorker().getEnv();
        await env.DB.exec("CREATE TABLE ci_isolation_probe (sentinel TEXT NOT NULL);");
        await env.DB.prepare("INSERT INTO ci_isolation_probe VALUES (?)").bind(message.sentinel).run();
        data = {
          pid: process.pid,
          arch: arch(),
          node: process.version,
          url: url.href,
          temp: process.env.TMPDIR,
          sqlite: sqliteFiles(process.env.TMPDIR ?? "").filter((path) => !before.has(path)),
        };
      }
      if (message.op === "read") {
        const env = await server.getWorker().getEnv();
        data = await env.DB.prepare("SELECT sentinel FROM ci_isolation_probe").first("sentinel");
      }
      if (message.op === "reset") {
        await server.reset();
        const env = await server.getWorker().getEnv();
        try {
          await env.DB.prepare("SELECT sentinel FROM ci_isolation_probe").first("sentinel");
          throw new Error("reset did not replace the first harness database");
        } catch (error) {
          if (!String(error).includes("no such table")) throw error;
        }
      }
      if (message.op === "close") await server.close();
      process.send?.({ id: message.id, data });
      if (message.op === "close") process.disconnect();
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) });
    }
  });
} else {
  const [configPath, firstId, secondId, firstCheckout, secondCheckout, output] = process.argv.slice(2);
  if (!output)
    throw new Error(
      "Usage: node scripts/probe-ci-isolation.mjs pool.json slot-01 slot-02 checkout-01 checkout-02 evidence.json",
    );
  const pool = validatePool(JSON.parse(readFileSync(configPath, "utf8")));
  const slots = [firstId, secondId].map((id) => {
    const slot = pool.slots.find(
      (/** @type {import('./lib/runner-pool.mjs').Slot} */ candidate) => candidate.id === id,
    );
    if (!slot) throw new Error(`Unknown slot ${id}`);
    return slot;
  });
  const checkouts = [firstCheckout, secondCheckout].map((path) => resolve(path));
  assert.notEqual(checkouts[0], checkouts[1]);
  const shas = checkouts.map((cwd) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim());
  assert.equal(shas[0], shas[1]);
  assert.equal(
    readFileSync(join(checkouts[0], "package-lock.json"), "utf8"),
    readFileSync(join(checkouts[1], "package-lock.json"), "utf8"),
  );
  const children = slots.map((slot, index) =>
    fork(join(checkouts[index], "scripts/probe-ci-isolation.mjs"), ["--child"], {
      cwd: checkouts[index],
      env: { ...process.env, ...slotEnvironment(pool, slot) },
      execPath: join(slot.directory, "externals/node24/bin/node"),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }),
  );
  let sequence = 0;
  /** @param {import('node:child_process').ChildProcess} child @param {Record<string, unknown>} message @returns {Promise<any>} */
  function ask(child, message) {
    const id = sequence++;
    return new Promise((resolveReply, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Harness probe timed out"));
      }, 60_000);
      /** @param {any} reply */
      function reply(reply) {
        if (reply.id !== id) return;
        cleanup();
        if (reply.error) reject(new Error(reply.error));
        else resolveReply(reply.data);
      }
      function exited() {
        cleanup();
        reject(new Error("Harness process exited before replying"));
      }
      function cleanup() {
        clearTimeout(timeout);
        child.off("message", reply);
        child.off("exit", exited);
      }
      child.on("message", reply);
      child.once("exit", exited);
      child.send({ ...message, id });
    });
  }
  let evidence;
  /** @type {number[]} */
  const observedPids = [];
  /** @param {number} pid */
  function observe(pid) {
    const processes = processFamily(pid);
    observedPids.push(...processes);
    return { processes, listeners: listeningSockets(processes) };
  }
  try {
    const info = await Promise.all(
      children.map((child, index) => ask(child, { op: "seed", sentinel: `slot-${index + 1}` })),
    );
    for (const entry of info) {
      Object.assign(entry, observe(entry.pid));
    }
    assert.notEqual(info[0].url, info[1].url);
    assert.notEqual(info[0].temp, info[1].temp);
    const firstPorts = new Set(info[0].listeners.map((/** @type {{port: number}} */ socket) => socket.port));
    assert(info[1].listeners.every((/** @type {{port: number}} */ socket) => !firstPorts.has(socket.port)));
    assert(info.every((entry) => entry.arch === "arm64" && entry.sqlite.length > 0));
    assert(info[0].sqlite.every((/** @type {string} */ path) => !info[1].sqlite.includes(path)));
    assert.equal(await ask(children[0], { op: "read" }), "slot-1");
    assert.equal(await ask(children[1], { op: "read" }), "slot-2");
    await ask(children[0], { op: "reset" });
    assert.equal(await ask(children[1], { op: "read" }), "slot-2");
    // reset starts a replacement runtime, which must also be tracked through
    // scoped shutdown rather than inferred from the original process family.
    for (const entry of info) entry.afterReset = observe(entry.pid);
    evidence = {
      sha: shas[0],
      slots: slots.map((slot) => slot.id),
      checkouts,
      harnesses: info,
      resetPreservedOtherDatabase: true,
    };
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null) return;
        const exit = once(child, "exit");
        try {
          await ask(child, { op: "close" });
        } catch {
          child.kill("SIGTERM");
        }
        await exit;
      }),
    );
  }
  const live = new Set(execFileSync("/bin/ps", ["-axo", "pid="], { encoding: "utf8" }).trim().split(/\s+/).map(Number));
  assert(
    observedPids.every((pid) => !live.has(pid)),
    "a harness left a job-owned process running",
  );
  writeFileSync(output, `${JSON.stringify({ ...evidence, ownedProcessesClosed: true }, null, 2)}\n`);
  console.log(`Two-harness isolation and scoped cleanup passed; evidence: ${output}`);
}
