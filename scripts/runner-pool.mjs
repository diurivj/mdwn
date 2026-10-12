#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  assertStartCapacity,
  containsPath,
  parseLaunchdRunners,
  serviceName,
  serviceTemplate,
  slotEnvironment,
  validatePool,
} from "./lib/runner-pool.mjs";

const [command, configPath, slotId] = process.argv.slice(2);
if (
  !configPath ||
  !["status", "inventory", "install", "service", "start", "stop", "stop-terminal", "trim-logs"].includes(command)
) {
  throw new Error(
    "Usage: node scripts/runner-pool.mjs status|inventory|install|service|start|stop|stop-terminal|trim-logs absolute-config.json [slot-id]",
  );
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Run this controller natively on the ARM64 Mac host");
const pool = validatePool(JSON.parse(readFileSync(resolve(configPath), "utf8")));
const account = userInfo();
if (account.username !== pool.owner || account.homedir !== pool.home || account.uid === 0) {
  throw new Error("Run as the configured service owner, with its actual home; macOS svc.sh must not run under sudo");
}

/** @param {string} executable @param {string[]} args @param {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} [options] */
function run(executable, args, options = { encoding: "utf8" }) {
  return execFileSync(executable, args, { maxBuffer: 20 * 1024 * 1024, ...options });
}
/** @param {string} endpoint @param {string[]} [args] */
function api(endpoint, args = []) {
  return JSON.parse(run("gh", ["api", endpoint, ...args]));
}
function processes() {
  return run("/bin/ps", ["-axo", "user=,pid=,ppid=,comm="])
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match ? [{ owner: match[1], pid: Number(match[2]), parent: Number(match[3]), executable: match[4] }] : [];
    });
}
function loadedServices() {
  const users = run("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"])
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\S+)\s+(\d+)\s*$/.exec(line);
      return match && Number(match[2]) >= 500 ? [Number(match[2])] : [];
    });
  const domains = ["system", ...new Set(users.flatMap((uid) => [`gui/${uid}`, `user/${uid}`]))];
  const labels = new Set();
  for (const domain of domains) {
    const result = spawnSync("launchctl", ["print", domain], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0) {
      if (/Could not find domain/.test(result.stderr ?? "")) continue;
      throw new Error(`Cannot inspect launchd domain ${domain}; capacity accounting fails closed`);
    }
    for (const label of parseLaunchdRunners(result.stdout)) {
      // Foreign reservations count conservatively in addition to live
      // listeners, since this pool does not own their installation paths.
      labels.add(domain === `gui/${account.uid}` ? label : `${domain}/${label}`);
    }
  }
  return [...labels];
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function registration(slot) {
  const file = join(slot.directory, ".runner");
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (
    data.gitHubUrl !== `https://github.com/${slot.repository}` ||
    data.agentName !== slot.name ||
    data.workFolder !== "_work"
  ) {
    throw new Error(`Registration mismatch in ${slot.id}; existing registrations are never replaced`);
  }
  return { id: data.agentId, name: data.agentName, repository: slot.repository };
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function remote(slot) {
  const entry = registration(slot);
  if (!entry) throw new Error(`${slot.id} is not registered`);
  return api(`repos/${slot.repository}/actions/runners/${entry.id}`);
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function assertLocallyIdle(slot) {
  const workers = processes().filter((entry) => entry.executable === join(slot.directory, "bin", "Runner.Worker"));
  if (workers.length || remote(slot).busy) throw new Error(`${slot.id} still has an executing job; retry when idle`);
}
/** Registration and service setup share the same writable-state invariant.
 * @param {import('./lib/runner-pool.mjs').Slot} slot
 */
function prepareState(slot) {
  const env = slotEnvironment(pool, slot);
  for (const path of [
    slot.state,
    env.NPM_CONFIG_CACHE,
    env.PLAYWRIGHT_BROWSERS_PATH,
    env.TMPDIR,
    env.AGENT_TOOLSDIRECTORY,
  ])
    mkdirSync(path, { recursive: true });
  return env;
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function prepareService(slot) {
  assertLocallyIdle(slot);
  const env = prepareState(slot);
  const backup = join(pool.root, "config", `${slot.id}-original`);
  mkdirSync(backup, { recursive: true });
  for (const name of [".path", ".env", ".service"]) {
    if (existsSync(join(slot.directory, name)) && !existsSync(join(backup, name)))
      copyFileSync(join(slot.directory, name), join(backup, name));
  }
  const plist = join(pool.home, "Library", "LaunchAgents", `${serviceName(slot)}.plist`);
  if (existsSync(plist) && !existsSync(join(backup, "service.plist")))
    copyFileSync(plist, join(backup, "service.plist"));
  const template = serviceTemplate(
    readFileSync(join(slot.directory, "bin", "actions.runner.plist.template"), "utf8"),
    pool,
    slot,
  );
  const templatePath = join(pool.root, "config", `${slot.id}-service.plist.template`);
  writeFileSync(templatePath, template);
  if (!existsSync(join(slot.directory, ".service"))) {
    run("./svc.sh", ["install"], {
      encoding: "utf8",
      cwd: slot.directory,
      env: { ...process.env, ...env, GITHUB_ACTIONS_RUNNER_SERVICE_TEMPLATE: templatePath },
    });
  } else {
    if (loadedServices().includes(serviceName(slot)))
      throw new Error("Stop the idle service before changing its environment");
    // Update only the inventoried service, preserving bundled svc.sh/runsvc.sh.
    const rendered = template
      .replaceAll("{{SvcName}}", serviceName(slot))
      .replaceAll("{{RunnerRoot}}", slot.directory)
      .replaceAll("{{UserHome}}", pool.home)
      .replaceAll("{{User}}", pool.owner);
    writeFileSync(plist, rendered);
  }
  writeFileSync(join(slot.directory, ".path"), pool.path);
  console.log(`Installed ${slot.id} service (stopped); original nonsecret configuration: ${backup}`);
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function install(slot) {
  if (slot.legacy)
    throw new Error("Use service for the original runner; its registration and installation are preserved");
  mkdirSync(slot.directory, { recursive: true });
  if (!existsSync(join(slot.directory, "config.sh"))) {
    if (readdirSync(slot.directory).length) throw new Error("Refusing extraction into a nonempty unknown installation");
    const release = api("repos/actions/runner/releases/latest");
    const asset = release.assets.find((/** @type {any} */ candidate) =>
      /^actions-runner-osx-arm64-[\d.]+\.tar\.gz$/.test(candidate.name),
    );
    if (
      !asset ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") ||
      !asset.browser_download_url.startsWith("https://github.com/actions/runner/releases/download/")
    ) {
      throw new Error("Official ARM64 release must publish a SHA-256 digest");
    }
    const archive = join(pool.root, "tools", asset.name);
    mkdirSync(join(pool.root, "tools"), { recursive: true });
    if (!existsSync(archive))
      run("curl", [
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--output",
        archive,
        asset.browser_download_url,
      ]);
    if (`sha256:${createHash("sha256").update(readFileSync(archive)).digest("hex")}` !== asset.digest)
      throw new Error("Runner archive checksum mismatch");
    run("tar", ["xzf", archive, "-C", slot.directory]);
    writeFileSync(
      join(slot.directory, "release-evidence.json"),
      `${JSON.stringify({ version: release.tag_name, url: asset.browser_download_url, digest: asset.digest }, null, 2)}\n`,
    );
  }
  if (!registration(slot)) {
    const environment = prepareState(slot);
    const token = api(`repos/${slot.repository}/actions/runners/registration-token`, ["--method", "POST"]).token;
    // The official listener consumes/masks ACTIONS_RUNNER_INPUT_TOKEN. Keep it
    // out of argv, service files, and command output; never copy credentials.
    const result = spawnSync(
      "./config.sh",
      [
        "--unattended",
        "--url",
        `https://github.com/${slot.repository}`,
        "--name",
        slot.name,
        "--work",
        "_work",
        "--labels",
        `${pool.label},${slot.id}`,
      ],
      {
        cwd: slot.directory,
        encoding: "utf8",
        env: { ...process.env, ...environment, ACTIONS_RUNNER_INPUT_TOKEN: token },
      },
    );
    if (result.status !== 0)
      throw new Error(`Registration failed for ${slot.id}; inspect its masked runner diagnostics`);
    registration(slot);
    for (const name of [".credentials", ".credentials_rsaparams"]) chmodSync(join(slot.directory, name), 0o600);
  }
  prepareService(slot);
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function start(slot) {
  if (!existsSync(join(slot.directory, ".service"))) throw new Error(`Install ${slot.id}'s service first`);
  const listeners = processes()
    .filter((entry) => /\/Runner\.Listener$/.test(entry.executable))
    .map((entry) => entry.executable);
  const loaded = loadedServices();
  assertStartCapacity(pool, listeners, loaded, slot);
  if (listeners.includes(join(slot.directory, "bin", "Runner.Listener")) && !loaded.includes(serviceName(slot))) {
    throw new Error("The slot is running outside launchd; gracefully stop its original terminal listener first");
  }
  const runner = remote(slot);
  api(`repos/${slot.repository}/actions/runners/${runner.id}/labels`, [
    "--method",
    "POST",
    "-f",
    `labels[]=${pool.label}`,
    "-f",
    `labels[]=${slot.id}`,
  ]);
  if (loaded.includes(serviceName(slot))) return console.log(`${slot.id} is already loaded; routing labels restored`);
  run("./svc.sh", ["start"], { encoding: "utf8", cwd: slot.directory });
  console.log(`Started ${slot.id}`);
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function stop(slot) {
  if (!loadedServices().includes(serviceName(slot))) return console.log(`${slot.id} is already stopped`);
  assertLocallyIdle(slot);
  const runner = remote(slot);
  // Removal is a routing aid, not a drain lock: old default-label jobs can
  // still match. The operator must use a quiet maintenance window.
  if (runner.labels.some((/** @type {any} */ label) => label.name === pool.label)) {
    run("gh", [
      "api",
      `repos/${slot.repository}/actions/runners/${runner.id}/labels/${pool.label}`,
      "--method",
      "DELETE",
    ]);
  }
  assertLocallyIdle(slot);
  run("./svc.sh", ["stop"], { encoding: "utf8", cwd: slot.directory });
  console.log(`Stopped ${slot.id}; start restores its pool label`);
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function stopTerminal(slot) {
  if (loadedServices().includes(serviceName(slot))) throw new Error("Use stop for a managed service");
  assertLocallyIdle(slot);
  const listeners = processes().filter(
    (entry) => entry.owner === pool.owner && entry.executable === join(slot.directory, "bin", "Runner.Listener"),
  );
  if (listeners.length !== 1) throw new Error("Expected exactly one inventoried terminal listener");
  process.kill(listeners[0].pid, "SIGINT");
  console.log(
    `Sent SIGINT to the idle ${slot.id} terminal listener (PID ${listeners[0].pid}); verify exit before starting its service`,
  );
}
/** @param {import('./lib/runner-pool.mjs').Slot} slot */
function trimLogs(slot) {
  if (loadedServices().includes(serviceName(slot))) throw new Error("Stop this idle slot before rotating logs");
  assertLocallyIdle(slot);
  if (processes().some((entry) => entry.executable.startsWith(`${slot.directory}/`)))
    throw new Error("Slot still owns processes");
  const directory = join(slot.directory, "_diag");
  const logs = readdirSync(directory)
    .filter((name) => /^(Runner|Worker)_[\w.-]+\.log$/.test(name))
    .map((name) => join(directory, name));
  logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const removed = logs.slice(60).filter((path) => Date.now() - statSync(path).mtimeMs > 30 * 86400_000);
  for (const path of removed) unlinkSync(path);
  const serviceLogs = join(pool.home, "Library", "Logs", serviceName(slot));
  for (const name of ["stdout.log", "stderr.log"]) {
    const path = join(serviceLogs, name);
    if (existsSync(path) && statSync(path).size > 10 * 1024 * 1024) {
      copyFileSync(path, `${path}.previous`);
      writeFileSync(path, "");
    }
  }
  console.log(
    `Removed ${removed.length} runner logs older than 30 days beyond the latest 60; rotated service logs over 10 MiB. Workspace and failure artifacts are retained.`,
  );
}
function status() {
  const local = processes();
  const loaded = loadedServices();
  return {
    timestamp: new Date().toISOString(),
    owner: pool.owner,
    maxActiveSlots: pool.maxActiveSlots,
    activeSlots: pool.activeSlots,
    allHostListeners: local.filter((entry) => /\/Runner\.Listener$/.test(entry.executable)),
    loadedServices: loaded,
    slots: pool.slots.map((/** @type {import('./lib/runner-pool.mjs').Slot} */ slot) => ({
      ...slot,
      registration: registration(slot),
      serviceName: serviceName(slot),
      servicePath: join(pool.home, "Library", "LaunchAgents", `${serviceName(slot)}.plist`),
      serviceLoaded: loaded.includes(serviceName(slot)),
      version: existsSync(join(slot.directory, "bin", "Runner.Listener"))
        ? run(join(slot.directory, "bin", "Runner.Listener"), ["--version"]).trim()
        : null,
      environment: slotEnvironment(pool, slot),
      github: registration(slot) ? remote(slot) : null,
      processes: local.filter((entry) => containsPath(slot.directory, entry.executable)),
    })),
  };
}

if (command === "status" || command === "inventory") {
  const result = status();
  if (command === "inventory") {
    const evidence = join(pool.root, "evidence");
    mkdirSync(evidence, { recursive: true });
    const system = {
      hardware: run("/usr/sbin/sysctl", [
        "-n",
        "machdep.cpu.brand_string",
        "hw.memsize",
        "hw.physicalcpu",
        "hw.logicalcpu",
      ]),
      os: run("sw_vers", []),
      disk: run("df", ["-k", pool.root]),
      power: run("pmset", ["-g", "custom"]),
      assertions: run("pmset", ["-g", "assertions"]),
      memory: run("vm_stat", []),
      swap: run("/usr/sbin/sysctl", ["vm.swapusage", "kern.memorystatus_vm_pressure_level"]),
    };
    const file = join(evidence, `inventory-${new Date().toISOString().replaceAll(":", "-")}.json`);
    writeFileSync(file, `${JSON.stringify({ ...result, system }, null, 2)}\n`);
    console.log(`Inventory saved: ${file}`);
  }
  console.log(JSON.stringify(result, null, 2));
} else {
  mkdirSync(join(pool.root, "config"), { recursive: true });
  const lock = join(pool.root, "config", ".pool.lock");
  mkdirSync(lock); // Atomic across simultaneous management commands.
  const lockOwner = join(lock, "owner.json");
  writeFileSync(
    lockOwner,
    `${JSON.stringify({ pid: process.pid, owner: pool.owner, command, created: new Date().toISOString() })}\n`,
  );
  try {
    const selected = slotId
      ? pool.slots.filter((/** @type {import('./lib/runner-pool.mjs').Slot} */ slot) => slot.id === slotId)
      : command === "start"
        ? pool.slots.filter((/** @type {import('./lib/runner-pool.mjs').Slot} */ slot) =>
            pool.activeSlots.includes(slot.id),
          )
        : [];
    if (!selected.length) throw new Error("A known slot ID is required (start without an ID uses activeSlots)");
    for (const slot of selected) {
      if (command === "install") install(slot);
      if (command === "service") prepareService(slot);
      if (command === "start") start(slot);
      if (command === "stop") stop(slot);
      if (command === "stop-terminal") stopTerminal(slot);
      if (command === "trim-logs") trimLogs(slot);
    }
  } finally {
    unlinkSync(lockOwner);
    rmdirSync(lock);
  }
}
