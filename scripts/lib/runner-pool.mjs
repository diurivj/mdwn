import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

/** @typedef {{id: string, repository: string, name: string, directory: string, state: string, legacy?: boolean}} Slot */
/** @typedef {{owner: string, home: string, root: string, path: string, label: string, maxActiveSlots: number, activeSlots: string[], slots: Slot[]}} Pool */

/** Resolve existing ancestors too, so symlinked caches cannot alias another slot.
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    const parent = resolve(path, "..");
    if (parent === path) throw error;
    return join(canonicalPath(parent), path.slice(parent.length + (parent === "/" ? 0 : 1)));
  }
}

/** @param {string} parent @param {string} child */
export function containsPath(parent, child) {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

/** @param {Pool} pool */
export function validatePool(pool) {
  if (!pool.owner || !/^[\w.-]+$/.test(pool.owner)) throw new Error("A service owner is required");
  if (!Number.isInteger(pool.maxActiveSlots) || pool.maxActiveSlots < 1 || pool.maxActiveSlots > 4) {
    throw new Error("The host budget must be between one and four total slots");
  }
  for (const path of [pool.home, pool.root]) {
    if (!isAbsolute(path) || normalize(path) !== path || path === "/" || /[$~\r\n]/.test(path)) {
      throw new Error("Pool paths must be expanded, normalized absolute directories");
    }
  }
  if (
    !containsPath(canonicalPath(pool.home), canonicalPath(pool.root)) ||
    canonicalPath(pool.root) === canonicalPath(pool.home)
  )
    throw new Error("The CI root must be a separate directory under the service owner's home");
  if (!pool.path || pool.path.split(":").some((entry) => !isAbsolute(entry) || /[$~\r\n]/.test(entry))) {
    throw new Error("PATH must contain explicit absolute directories");
  }
  if (!/^[\w.-]+$/.test(pool.label)) throw new Error("A common pool label is required");
  const ids = new Set();
  const names = new Set();
  const services = new Set();
  /** @type {string[]} */
  const writable = [];
  for (const slot of pool.slots) {
    if (!/^[\w.-]+$/.test(slot.id) || ids.has(slot.id) || names.has(`${slot.repository}/${slot.name}`)) {
      throw new Error("Slot IDs and repository runner names must be unique");
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(slot.repository) || !/^[\w.-]+$/.test(slot.name)) {
      throw new Error("Invalid repository or runner name");
    }
    ids.add(slot.id);
    names.add(`${slot.repository}/${slot.name}`);
    if (services.has(serviceName(slot)))
      throw new Error("Derived launchd service names must be unique across repositories");
    services.add(serviceName(slot));
    for (const path of [slot.directory, slot.state]) {
      if (!isAbsolute(path) || normalize(path) !== path || /[$~\r\n]/.test(path)) {
        throw new Error("Slot paths must be expanded, normalized absolute directories");
      }
      const canonical = canonicalPath(path);
      if (canonical === canonicalPath(pool.home) || canonical === "/") throw new Error("Unsafe slot root");
      if ((!slot.legacy || path === slot.state) && !containsPath(canonicalPath(pool.root), canonical)) {
        throw new Error("New installations and all state must stay inside the CI root");
      }
      if (writable.some((previous) => containsPath(previous, canonical) || containsPath(canonical, previous))) {
        throw new Error("Slots must have disjoint installation and state directories");
      }
      writable.push(canonical);
    }
    const environment = slotEnvironment(pool, slot);
    const work = canonicalPath(join(slot.directory, "_work"));
    const installation = canonicalPath(slot.directory);
    const state = canonicalPath(slot.state);
    if (work === installation || !containsPath(installation, work))
      throw new Error("Workspace symlink escapes its installation");
    const resources = [
      environment.NPM_CONFIG_CACHE,
      environment.PLAYWRIGHT_BROWSERS_PATH,
      environment.TMPDIR,
      environment.AGENT_TOOLSDIRECTORY,
    ].map((path) => canonicalPath(path.replace(/\/$/, "")));
    for (const [index, resource] of resources.entries()) {
      const parent = index === 3 ? work : state;
      if (resource === parent || !containsPath(parent, resource))
        throw new Error("Writable resource symlink escapes its slot");
      if (
        resources
          .slice(0, index)
          .some((previous) => containsPath(previous, resource) || containsPath(resource, previous))
      )
        throw new Error("Writable resources must be disjoint");
    }
  }
  if (new Set(pool.activeSlots).size !== pool.activeSlots.length || pool.activeSlots.some((id) => !ids.has(id))) {
    throw new Error("Active slots must reference unique inventoried slots");
  }
  if (pool.activeSlots.length > pool.maxActiveSlots) throw new Error("Configured capacity exceeds the host budget");
  return pool;
}

/** @param {Pool} pool @param {Slot} slot */
export function slotEnvironment(pool, slot) {
  return {
    PATH: pool.path,
    USER: pool.owner,
    LOGNAME: pool.owner,
    LANG: "en_US.UTF-8",
    NPM_CONFIG_CACHE: join(slot.state, "npm-cache"),
    PLAYWRIGHT_BROWSERS_PATH: join(slot.state, "playwright-browsers"),
    TMPDIR: `${join(slot.state, "tmp")}/`,
    AGENT_TOOLSDIRECTORY: join(slot.directory, "_work", "_tool"),
    MDWN_CI_SLOT_STATE: slot.state,
  };
}

/** @param {Slot} slot */
export function serviceName(slot) {
  return `actions.runner.${slot.repository.replace("/", "-")}.${slot.name}`;
}

/** @param {string} value */
function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Preserve the supplied macOS template and runsvc.sh entry point.
 * @param {string} template @param {Pool} pool @param {Slot} slot
 */
export function serviceTemplate(template, pool, slot) {
  const entries = Object.entries(slotEnvironment(pool, slot))
    .map(([key, value]) => `      <key>${key}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
  if (!template.includes("<key>ACTIONS_RUNNER_SVC</key>")) throw new Error("Unrecognized official service template");
  const securitySession = /<key>SessionCreate<\/key>\s*<(?:true|false)\s*\/>/g;
  if ([...template.matchAll(securitySession)].length !== 1)
    throw new Error("Unrecognized official service security-session setting");
  return (
    template
      // A separate security session breaks WebKit's IndexedDB CryptoKey storage
      // on this host. Keep the logged-in GUI user's session, not new credentials.
      .replace(securitySession, "<key>SessionCreate</key>\n    <false/>")
      .replace("<key>ACTIONS_RUNNER_SVC</key>", `${entries}\n      <key>ACTIONS_RUNNER_SVC</key>`)
      .replace(
        "<key>RunAtLoad</key>",
        "<key>KeepAlive</key>\n    <true/>\n    <key>ThrottleInterval</key>\n    <integer>30</integer>\n    <key>RunAtLoad</key>",
      )
  );
}

/** Capture one pre-change snapshot, including absent files. Later service
 * creation must not turn a generated plist into an "original" backup.
 * @param {Pool} pool @param {Slot} slot
 */
export function snapshotOriginalService(pool, slot) {
  const backup = join(pool.root, "config", `${slot.id}-original`);
  const marker = join(backup, "snapshot.json");
  const sources = [
    ...[".path", ".env", ".service"].map((name) => [name, join(slot.directory, name)]),
    ["service.plist", join(pool.home, "Library", "LaunchAgents", `${serviceName(slot)}.plist`)],
  ];
  if (existsSync(marker)) {
    const snapshot = JSON.parse(readFileSync(marker, "utf8"));
    if (snapshot.version !== 1 || snapshot.slot !== slot.id || snapshot.directory !== slot.directory)
      throw new Error("Original snapshot identity does not match this slot");
    if (
      !sources.every(
        ([name]) =>
          typeof snapshot.files?.[name] === "boolean" && existsSync(join(backup, name)) === snapshot.files[name],
      )
    )
      throw new Error("Original snapshot file-presence record is incomplete or changed");
    return backup;
  }
  if (existsSync(backup) && readdirSync(backup).length)
    throw new Error("Legacy original backup needs an inventoried snapshot.json before service changes");
  mkdirSync(backup, { recursive: true });
  const files = Object.fromEntries(
    sources.map(([name, source]) => {
      const present = existsSync(source);
      if (present) copyFileSync(source, join(backup, name), constants.COPYFILE_EXCL);
      return [name, present];
    }),
  );
  writeFileSync(
    marker,
    `${JSON.stringify({ version: 1, slot: slot.id, directory: slot.directory, files }, null, 2)}\n`,
    { flag: "wx" },
  );
  return backup;
}

/** Count every listener, including other repositories/accounts. Loaded services
 * reserve capacity while their listener starts or restarts.
 * @param {Pool} pool @param {string[]} listeners @param {string[]} loadedServices @param {Slot} target
 */
export function assertStartCapacity(pool, listeners, loadedServices, target) {
  if (!pool.activeSlots.includes(target.id)) throw new Error("Slot is outside the configured active pool");
  const reservations = loadedServices.filter((name) => {
    const slot = pool.slots.find((candidate) => serviceName(candidate) === name);
    return !slot || !listeners.includes(join(slot.directory, "bin", "Runner.Listener"));
  }).length;
  const alreadyPresent =
    listeners.includes(join(target.directory, "bin", "Runner.Listener")) ||
    loadedServices.includes(serviceName(target));
  if (listeners.length + reservations + Number(!alreadyPresent) > pool.maxActiveSlots) {
    throw new Error("Starting this slot would exceed the host-wide listener budget");
  }
}

/** Only loaded service rows, not disabled-services/environment sections.
 * @param {string} output
 */
export function parseLaunchdRunners(output) {
  return [...output.matchAll(/^\s*(?:\d+|-)\s+\S+\s+(actions\.runner\.[\w.-]+)\s*$/gm)].map((match) => match[1]);
}
