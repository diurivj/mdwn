CREATE TABLE `pseudonym_update_items` (
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`content_key_envelope` blob,
	`content_key_epoch` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `kind`, `record_id`),
	FOREIGN KEY (`job_id`) REFERENCES `crypto_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "pseudonym_update_items_kind_valid" CHECK("pseudonym_update_items"."kind" IN ('thread', 'publication')),
	CONSTRAINT "pseudonym_update_items_revision_positive" CHECK("pseudonym_update_items"."revision" >= 1),
	CONSTRAINT "pseudonym_update_items_shape" CHECK(("pseudonym_update_items"."kind" = 'thread' AND "pseudonym_update_items"."content_key_envelope" IS NOT NULL
      AND "pseudonym_update_items"."content_key_epoch" IS NOT NULL AND "pseudonym_update_items"."content_key_epoch" >= 1)
    OR ("pseudonym_update_items"."kind" = 'publication' AND "pseudonym_update_items"."content_key_envelope" IS NULL AND "pseudonym_update_items"."content_key_epoch" IS NULL)),
	CONSTRAINT "pseudonym_update_items_bounded" CHECK(length("pseudonym_update_items"."ciphertext") BETWEEN 1 AND 4096
    AND ("pseudonym_update_items"."content_key_envelope" IS NULL OR length("pseudonym_update_items"."content_key_envelope") BETWEEN 1 AND 16384))
);
--> statement-breakpoint
CREATE TABLE `pseudonym_update_profiles` (
	`job_id` text PRIMARY KEY NOT NULL,
	`ciphertext` blob NOT NULL,
	`epoch` integer NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `crypto_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "pseudonym_update_profiles_epoch_positive" CHECK("pseudonym_update_profiles"."epoch" >= 1),
	CONSTRAINT "pseudonym_update_profiles_revision_positive" CHECK("pseudonym_update_profiles"."revision" >= 1),
	CONSTRAINT "pseudonym_update_profiles_bounded" CHECK(length("pseudonym_update_profiles"."ciphertext") BETWEEN 1 AND 4096)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_crypto_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`device_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`cursor` text,
	`initiating_account_id` text,
	`target_id` text,
	`key_epoch` integer,
	`progress` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`initiating_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_id`) REFERENCES `vault_nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "crypto_jobs_kind_valid" CHECK("__new_crypto_jobs"."kind" IN ('recovery_owned', 'enrollment_owned', 'key_rotation', 'pseudonym_update')),
	CONSTRAINT "crypto_jobs_state_valid" CHECK("__new_crypto_jobs"."state" IN ('pending', 'complete', 'cancelled')),
	CONSTRAINT "crypto_jobs_rotation_metadata" CHECK("__new_crypto_jobs"."progress" >= 0 AND ("__new_crypto_jobs"."kind" != 'key_rotation' OR
    ("__new_crypto_jobs"."target_id" IS NOT NULL AND "__new_crypto_jobs"."key_epoch" IS NOT NULL AND "__new_crypto_jobs"."key_epoch" >= 1 AND "__new_crypto_jobs"."initiating_account_id" IS NOT NULL)))
);
--> statement-breakpoint
INSERT INTO `__new_crypto_jobs`("id", "account_id", "device_id", "kind", "state", "cursor", "initiating_account_id", "target_id", "key_epoch", "progress", "created_at", "updated_at") SELECT "id", "account_id", "device_id", "kind", "state", "cursor", "initiating_account_id", "target_id", "key_epoch", "progress", "created_at", "updated_at" FROM `crypto_jobs`;--> statement-breakpoint
DROP TABLE `crypto_jobs`;--> statement-breakpoint
ALTER TABLE `__new_crypto_jobs` RENAME TO `crypto_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `crypto_jobs_device_idx` ON `crypto_jobs` (`account_id`,`device_id`,`state`);--> statement-breakpoint
CREATE INDEX `crypto_jobs_account_kind_idx` ON `crypto_jobs` (`account_id`,`kind`,`state`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `crypto_jobs_rotation_target_idx` ON `crypto_jobs` (`target_id`) WHERE "crypto_jobs"."kind" = 'key_rotation' AND "crypto_jobs"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `crypto_jobs_pseudonym_pending_idx` ON `crypto_jobs` (`account_id`) WHERE "crypto_jobs"."kind" = 'pseudonym_update' AND "crypto_jobs"."state" = 'pending';--> statement-breakpoint
ALTER TABLE `account_profiles` ADD `pseudonym_changed_at` integer;--> statement-breakpoint
-- Staged Pseudonym-update material exists only beneath a `pseudonym_update`
-- crypto job; the service never persists a staged item for another job kind.
CREATE TRIGGER pseudonym_update_items_job_guard BEFORE INSERT ON pseudonym_update_items
BEGIN
  SELECT RAISE(ABORT, 'pseudonym update job required')
  WHERE NOT EXISTS (SELECT 1 FROM crypto_jobs j WHERE j.id = NEW.job_id AND j.kind = 'pseudonym_update');
END;
--> statement-breakpoint
CREATE TRIGGER pseudonym_update_profiles_job_guard BEFORE INSERT ON pseudonym_update_profiles
BEGIN
  SELECT RAISE(ABORT, 'pseudonym update job required')
  WHERE NOT EXISTS (SELECT 1 FROM crypto_jobs j WHERE j.id = NEW.job_id AND j.kind = 'pseudonym_update');
END;