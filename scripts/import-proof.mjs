#!/usr/bin/env node
/**
 * Disposable remote Workers Free + D1 proof for the Import staging protocol
 * (tickets 26 and 30) and the ticket-33 release-gate criteria (exact-limit
 * create/save/Replace, active-Publication paired updates, stale-conflict
 * preservation, and missing-sequence rejection).
 *
 * Usage:
 *   npx wrangler login                     # once per machine
 *   node scripts/import-proof.mjs          # provision, run, tear down
 *   node scripts/import-proof.mjs --keep   # keep the deployment for inspection
 *   node scripts/import-proof.mjs --db-id <uuid>   # reuse an existing proof DB
 *
 * Requires the Cloudflare account to be on Workers Free + D1 Free: the proof's
 * statement-budget evidence is that the worst-case upload and commit succeed
 * while D1 enforces the Free 50-queries-per-invocation limit. The script
 * creates a throwaway Worker + D1, applies the committed migrations, seeds one
 * device-bound Session (no production test endpoints), runs
 * `vitest.proof.config.ts`, and deletes everything again.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCookie } from "react-router";

const PROOF_DB = "mdwn-import-proof-db";
const PROOF_WORKER = "mdwn-import-proof";
const PROOF_CONFIG = "wrangler.proof.jsonc";
const DB_BINDING = "DB";

const keep = process.argv.includes("--keep");
const dbIdArgument = process.argv[process.argv.indexOf("--db-id") + 1];
const requestedDbId = process.argv.includes("--db-id") ? dbIdArgument : process.env.PROOF_D1_ID;

/** @param {string} command @param {string[]} args @param {import("node:child_process").SpawnSyncOptions} [options] */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed`);
  }
}

/** @param {string} command @param {string[]} args @returns {string} */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed:\n${result.stderr ?? ""}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function id() {
  const value = crypto.randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

/** @param {string} databaseId @returns {string} */
function proofConfig(databaseId) {
  return `${JSON.stringify(
    {
      $schema: "node_modules/wrangler/config-schema.json",
      name: PROOF_WORKER,
      compatibility_date: "2026-09-18",
      main: "./workers/app.ts",
      vars: { APP_ENV: "local" },
      observability: { enabled: false },
      version_metadata: { binding: "CF_VERSION_METADATA" },
      upload_source_maps: true,
      d1_databases: [
        {
          binding: DB_BINDING,
          database_name: PROOF_DB,
          database_id: databaseId,
          migrations_dir: "./drizzle",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** @returns {string | null} */
function existingDatabaseId() {
  const output = capture("npx", ["--no-install", "wrangler", "d1", "list", "--json"]);
  const databases = /** @type {{ name: string, uuid: string }[]} */ (
    JSON.parse(output.slice(output.indexOf("["), output.lastIndexOf("]") + 1))
  );
  return databases.find((database) => database.name === PROOF_DB)?.uuid ?? null;
}

function cleanup() {
  if (keep) {
    console.log(`\nKeeping the proof deployment (${PROOF_WORKER}, ${PROOF_DB}). Delete it with:`);
    console.log(`  npx wrangler delete ${PROOF_WORKER}`);
    console.log(`  npx wrangler d1 delete ${PROOF_DB} -y`);
    return;
  }
  spawnSync("npx", ["--no-install", "wrangler", "delete", PROOF_WORKER], {
    stdio: ["pipe", "ignore", "ignore"],
    input: "y\n",
  });
  spawnSync("npx", ["--no-install", "wrangler", "d1", "delete", PROOF_DB, "-y"], { stdio: "ignore" });
  console.log(`✓ proof deployment deleted (${PROOF_WORKER}, ${PROOF_DB})`);
}

const temporary = mkdtempSync(join(tmpdir(), "mdwn-import-proof-"));
/** @type {string | undefined} */
let databaseId = requestedDbId ?? undefined;
try {
  capture("npx", ["--no-install", "wrangler", "whoami"]);
  if (!databaseId) databaseId = existingDatabaseId() ?? undefined;
  if (!databaseId) {
    run("npx", ["--no-install", "wrangler", "d1", "create", PROOF_DB, "--location", "weur"]);
    databaseId = existingDatabaseId() ?? undefined;
  }
  if (!databaseId) throw new Error("could not resolve the proof D1 id");
  console.log(`✓ disposable D1 ${PROOF_DB} (${databaseId})`);
  writeFileSync(PROOF_CONFIG, proofConfig(databaseId));

  run("npx", ["--no-install", "react-router", "build"], {
    env: { ...process.env, WRANGLER_CONFIG: PROOF_CONFIG },
  });
  const built = JSON.parse(readFileSync("build/server/wrangler.json", "utf8"));
  if (built.name !== PROOF_WORKER) throw new Error(`built Worker is ${built.name}, not ${PROOF_WORKER}`);

  run("npx", [
    "--no-install",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    DB_BINDING,
    "--remote",
    "--config",
    PROOF_CONFIG,
  ]);

  const sessionSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  const abuseSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  const secretsFile = join(temporary, "secrets.json");
  writeFileSync(secretsFile, JSON.stringify({ SESSION_COOKIE_SECRET: sessionSecret, ABUSE_HMAC_SECRET: abuseSecret }), {
    mode: 0o600,
  });
  const deployOutput = capture("npx", ["--no-install", "wrangler", "deploy", "--secrets-file", secretsFile]);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences from Wrangler output.
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployOutput.replace(/\u001b\[[0-9;]*m/g, ""))?.[0];
  if (!url) throw new Error("could not read the deployed workers.dev URL");
  // A freshly created or re-created workers.dev route can take a few seconds
  // to serve, and can flap briefly after that; require three consecutive
  // healthy responses before running instead of turning proof requests into
  // 404s.
  let ready = false;
  for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
    let healthy = 0;
    for (let probe = 0; probe < 3; probe += 1) {
      try {
        const response = await fetch(`${url}/robots.txt`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) break;
        healthy += 1;
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    ready = healthy === 3;
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!ready) throw new Error(`deployed ${url} is still not serving after 20 attempts`);
  console.log(`✓ deployed ${url}`);

  const accountId = id(),
    rootId = id(),
    deviceId = id(),
    sessionId = id();
  const secondAccountId = id(),
    credentialId = id();
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  /** @param {Uint8Array} bytes @returns {string} */
  const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const seedSql = `
    INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES ('${accountId}', '${id()}', ${now}, ${now});
    INSERT INTO accounts (id, share_id, created_at, updated_at) VALUES ('${secondAccountId}', '${id()}', ${now}, ${now});
    INSERT INTO account_encryption_identities (account_id, root_directory_id, registry_epoch) VALUES ('${accountId}', '${rootId}', 1);
    INSERT INTO encryption_devices (id, account_id, transport_public_key, assertion_public_key, state, approval_provenance, registry_epoch, created_at)
      VALUES ('${deviceId}', '${accountId}', X'01', X'${hex(publicRaw)}', 'active', 'signup', 1, ${now});
    INSERT INTO sessions (id, account_id, purpose, authenticated_passkey_id, created_at, idle_expires_at, absolute_expires_at, revoked_at, device_id)
      VALUES ('${sessionId}', '${accountId}', 'normal', '${credentialId}', ${now}, ${now + 86_400_000}, ${now + 86_400_000}, NULL, '${deviceId}');
  `;
  const seedFile = join(temporary, "seed.sql");
  writeFileSync(seedFile, seedSql);
  run("npx", [
    "--no-install",
    "wrangler",
    "d1",
    "execute",
    DB_BINDING,
    "--remote",
    "--config",
    PROOF_CONFIG,
    "--file",
    seedFile,
  ]);
  const cookie = await createCookie("__Host-mdwn_session", {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
    secrets: [sessionSecret],
  }).serialize(sessionId);
  console.log(`✓ seeded a device-bound Session for ${accountId}`);
  const proofEnv = {
    PROOF_BASE_URL: url,
    PROOF_SESSION_COOKIE: cookie.split(";", 1)[0],
    PROOF_SESSION_ID: sessionId,
    PROOF_ACCOUNT_ID: accountId,
    PROOF_ROOT_ID: rootId,
    PROOF_DEVICE_ID: deviceId,
    PROOF_SECOND_ACCOUNT_ID: secondAccountId,
    PROOF_DEVICE_JWK: JSON.stringify(privateJwk),
    PROOF_WRANGLER_CONFIG: PROOF_CONFIG,
    PROOF_D1_NAME: PROOF_DB,
  };
  writeFileSync("/tmp/mdwn-proof-env.json", JSON.stringify(proofEnv, null, 2));

  run("npx", ["--no-install", "vitest", "run", "--config", "vitest.proof.config.ts"], {
    env: { ...process.env, ...proofEnv },
  });
  console.log("\n✓ Workers Free + D1 release proof passed");
} finally {
  rmSync(PROOF_CONFIG, { force: true });
  rmSync(temporary, { recursive: true, force: true });
  rmSync("/tmp/mdwn-proof-env.json", { force: true });
  cleanup();
}
