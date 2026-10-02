-- Preserve reviewed tree FKs/triggers; only crypto_jobs needs a constraint rebuild.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE crypto_jobs_next (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL REFERENCES encryption_devices(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('recovery_owned', 'enrollment_owned', 'key_rotation')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'cancelled')),
  cursor TEXT,
  initiating_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  target_id TEXT REFERENCES vault_nodes(id) ON DELETE RESTRICT,
  key_epoch INTEGER,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (kind != 'key_rotation' OR (target_id IS NOT NULL AND key_epoch IS NOT NULL AND key_epoch >= 1 AND initiating_account_id IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO crypto_jobs_next (id, account_id, device_id, kind, state, cursor, created_at, updated_at)
  SELECT id, account_id, device_id, kind, state, cursor, created_at, updated_at FROM crypto_jobs;
--> statement-breakpoint
DROP TABLE crypto_jobs;
--> statement-breakpoint
ALTER TABLE crypto_jobs_next RENAME TO crypto_jobs;
--> statement-breakpoint
CREATE INDEX crypto_jobs_device_idx ON crypto_jobs(account_id, device_id, state);
--> statement-breakpoint
CREATE INDEX crypto_jobs_account_kind_idx ON crypto_jobs(account_id, kind, state, id);
--> statement-breakpoint
CREATE UNIQUE INDEX crypto_jobs_rotation_target_idx ON crypto_jobs(target_id) WHERE kind = 'key_rotation' AND state = 'pending';
--> statement-breakpoint
ALTER TABLE directories ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch >= 1);
--> statement-breakpoint
ALTER TABLE sharing_write_blocks ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 2 CHECK (key_epoch >= 1);
