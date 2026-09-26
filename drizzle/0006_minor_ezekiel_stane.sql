CREATE TABLE `device_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`candidate_session_id` text NOT NULL,
	`candidate_device_id` text NOT NULL,
	`transport_public_key` blob NOT NULL,
	`assertion_public_key` blob NOT NULL,
	`transcript` blob NOT NULL,
	`transcript_digest` blob NOT NULL,
	`pairing_secret_hash` blob NOT NULL,
	`registry_epoch` integer NOT NULL,
	`state` text NOT NULL,
	`approving_device_id` text,
	`approving_session_id` text,
	`approving_proof_id` text,
	`approval_message` blob,
	`approval_signature` blob,
	`enrollment_envelope` blob,
	`envelope_digest` blob,
	`challenge_ciphertext` blob,
	`challenge_hash` blob,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`candidate_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "device_enrollments_state_valid" CHECK("device_enrollments"."state" IN ('pending', 'challenged', 'consumed')),
	CONSTRAINT "device_enrollments_expiry_valid" CHECK("device_enrollments"."expires_at" > "device_enrollments"."created_at" AND "device_enrollments"."expires_at" <= "device_enrollments"."created_at" + 600000),
	CONSTRAINT "device_enrollments_epoch_positive" CHECK("device_enrollments"."registry_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `device_enrollments_candidate_idx` ON `device_enrollments` (`candidate_session_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `device_enrollments_account_idx` ON `device_enrollments` (`account_id`,`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_crypto_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`device_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`cursor` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "crypto_jobs_kind_valid" CHECK("__new_crypto_jobs"."kind" IN ('recovery_owned', 'enrollment_owned')),
	CONSTRAINT "crypto_jobs_state_valid" CHECK("__new_crypto_jobs"."state" IN ('pending', 'complete'))
);
--> statement-breakpoint
INSERT INTO `__new_crypto_jobs`("id", "account_id", "device_id", "kind", "state", "cursor", "created_at", "updated_at") SELECT "id", "account_id", "device_id", "kind", "state", "cursor", "created_at", "updated_at" FROM `crypto_jobs`;--> statement-breakpoint
DROP TABLE `crypto_jobs`;--> statement-breakpoint
ALTER TABLE `__new_crypto_jobs` RENAME TO `crypto_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `crypto_jobs_device_idx` ON `crypto_jobs` (`account_id`,`device_id`,`state`);--> statement-breakpoint
ALTER TABLE `encryption_devices` ADD `label_ciphertext` blob;