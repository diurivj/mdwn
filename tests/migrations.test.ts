import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DRIZZLE_DIR = join(process.cwd(), "drizzle");

describe("committed Drizzle migrations", () => {
  const migrations = readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("has at least one migration, lexically ordered from 0000", () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]).toMatch(/^0000_/);
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].localeCompare(migrations[i - 1])).toBeGreaterThan(0);
    }
  });

  it("the foundation migration creates the locked accounts table only", () => {
    const sql = readFileSync(join(DRIZZLE_DIR, migrations[0]), "utf8");
    expect(sql).toContain("CREATE TABLE `accounts`");
    expect(sql).toContain("`share_id` text NOT NULL");
    expect(sql).toContain("`created_at` integer NOT NULL");
    // No speculative tables in the foundation migration.
    for (const premature of ["passkeys", "sessions", "vault_nodes", "key_envelopes", "comments"]) {
      expect(sql).not.toContain(`CREATE TABLE \`${premature}\``);
    }
  });

  it("journal records every migration file (schema-drift guard)", () => {
    const journal = JSON.parse(
      readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
    );
    const tags: string[] = (journal.entries as Array<{ tag: string }>).map((e) => e.tag);
    expect(tags).toHaveLength(migrations.length);
    for (const m of migrations) {
      expect(tags).toContain(m.replace(/\.sql$/, ""));
    }
  });

  it("stores only bounded abuse counters and allowlisted Security event columns", () => {
    const sql = readFileSync(join(DRIZZLE_DIR, "0002_hesitant_sphinx.sql"), "utf8");

    expect(sql).toContain("CREATE TABLE `rate_limit_counters`");
    expect(sql).toContain("CREATE TABLE `security_events`");
    expect(sql).toContain("`time_epoch` integer NOT NULL");
    expect(sql).toContain("`network_bucket_expires_at` integer");
    expect(sql).toContain("security_events_retention_bounded");
    expect(sql).toContain("security_events_network_bucket_bounded");
    expect(sql).not.toMatch(/raw_ip|full_url|request_headers|request_body|cookie|user_agent|fingerprint|capability|fragment/i);
  });

  it("adds the signup registry and recovery records without plaintext secrets", () => {
    const sql = readFileSync(join(DRIZZLE_DIR, "0003_colossal_falcon.sql"), "utf8");
    for (const table of ["account_encryption_identities", "encryption_devices", "key_envelopes",
      "recovery_capsules", "authentication_recovery_codes", "registration_challenges", "device_proof_uses"]) {
      expect(sql).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(sql).toContain("`device_id` text");
    expect(sql).not.toMatch(/private_key|recovery_secret|recovery_phrase|raw_ip|user_agent/i);
  });

  it("keeps authentication records separate from opaque Account identity", () => {
    const sql = readFileSync(join(DRIZZLE_DIR, "0001_accounts_auth.sql"), "utf8");

    for (const table of [
      "account_profiles",
      "passkeys",
      "webauthn_challenges",
      "sessions",
    ]) {
      expect(sql).toContain(`CREATE TABLE \`${table}\``);
    }

    expect(sql).toContain("`ciphertext` blob NOT NULL");
    expect(sql).toContain("`purpose` text NOT NULL");
    expect(sql).toContain("`revoked_at` integer");
    expect(sql).not.toMatch(/email|password|pseudonym|handle(?!_lookup_token)/i);
  });
});
