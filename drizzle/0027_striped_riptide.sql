-- Keep immutable visibility markers after their short-lived staging is purged.
-- D1 always enforces FKs; defer only within this migration transaction.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_import_commits` (
	`import_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`target_directory_id` text NOT NULL,
	`committed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_commits_target_opaque" CHECK(length("__new_import_commits"."target_directory_id") = 36)
);
--> statement-breakpoint
INSERT INTO `__new_import_commits`("import_id", "account_id", "target_directory_id", "committed_at") SELECT "import_id", "account_id", "target_directory_id", "committed_at" FROM `import_commits`;--> statement-breakpoint
DROP TABLE `import_commits`;--> statement-breakpoint
ALTER TABLE `__new_import_commits` RENAME TO `import_commits`;--> statement-breakpoint
CREATE INDEX `import_commits_account_idx` ON `import_commits` (`account_id`,`committed_at`);
--> statement-breakpoint
-- Rebuilding a table drops its triggers: reinstall the immutable marker guard.
CREATE TRIGGER import_commits_immutable BEFORE UPDATE ON import_commits
BEGIN SELECT RAISE(ABORT, 'import commit immutable'); END;
--> statement-breakpoint
-- Preserve the originating-session invariant on insert, without making that
-- ephemeral row a permanent FK parent of committed content.
CREATE TRIGGER import_commits_session_guard BEFORE INSERT ON import_commits
WHEN NOT EXISTS (SELECT 1 FROM import_sessions s WHERE s.id = NEW.import_id
  AND s.account_id = NEW.account_id AND s.target_directory_id = NEW.target_directory_id)
BEGIN SELECT RAISE(ABORT, 'import commit session required'); END;
--> statement-breakpoint
-- Additive guards avoid rebuilding Session-referencing ceremony tables.
-- Shorten any legacy overlong records before enforcing the ceiling.
UPDATE webauthn_challenges SET expires_at = created_at + 600000 WHERE expires_at > created_at + 600000;
--> statement-breakpoint
UPDATE registration_challenges SET expires_at = created_at + 600000 WHERE expires_at > created_at + 600000;
--> statement-breakpoint
UPDATE recovery_enrollments SET expires_at = created_at + 600000 WHERE expires_at > created_at + 600000;
--> statement-breakpoint
CREATE TRIGGER webauthn_challenges_lifetime_insert BEFORE INSERT ON webauthn_challenges
WHEN NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + 600000
BEGIN SELECT RAISE(ABORT, 'challenge lifetime exceeded'); END;
--> statement-breakpoint
CREATE TRIGGER webauthn_challenges_lifetime_update BEFORE UPDATE OF created_at, expires_at ON webauthn_challenges
WHEN NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + 600000
BEGIN SELECT RAISE(ABORT, 'challenge lifetime exceeded'); END;
--> statement-breakpoint
CREATE TRIGGER registration_challenges_lifetime_insert BEFORE INSERT ON registration_challenges
WHEN NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + 600000
BEGIN SELECT RAISE(ABORT, 'challenge lifetime exceeded'); END;
--> statement-breakpoint
CREATE TRIGGER registration_challenges_lifetime_update BEFORE UPDATE OF created_at, expires_at ON registration_challenges
WHEN NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + 600000
BEGIN SELECT RAISE(ABORT, 'challenge lifetime exceeded'); END;
--> statement-breakpoint
CREATE TRIGGER recovery_enrollments_lifetime_insert BEFORE INSERT ON recovery_enrollments
WHEN NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + 600000
BEGIN SELECT RAISE(ABORT, 'challenge lifetime exceeded'); END;
--> statement-breakpoint
CREATE TRIGGER recovery_enrollments_lifetime_update BEFORE UPDATE OF created_at, expires_at ON recovery_enrollments
WHEN NEW.expires_at <= NEW.created_at OR NEW.expires_at > NEW.created_at + 600000
BEGIN SELECT RAISE(ABORT, 'challenge lifetime exceeded'); END;