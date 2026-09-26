CREATE TABLE `crypto_jobs` (
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
	CONSTRAINT "crypto_jobs_kind_valid" CHECK("crypto_jobs"."kind" = 'recovery_owned'),
	CONSTRAINT "crypto_jobs_state_valid" CHECK("crypto_jobs"."state" IN ('pending', 'complete'))
);
--> statement-breakpoint
CREATE INDEX `crypto_jobs_device_idx` ON `crypto_jobs` (`account_id`,`device_id`,`state`);--> statement-breakpoint
CREATE TABLE `recovery_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`session_id` text NOT NULL,
	`generation` integer NOT NULL,
	`registry_epoch` integer NOT NULL,
	`nonce` blob NOT NULL,
	`state` text NOT NULL,
	`candidate_device_id` text,
	`transport_public_key` blob,
	`assertion_public_key` blob,
	`intent_digest` blob,
	`next_metadata_digest` blob,
	`challenge_hash` blob,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "recovery_enrollments_state_valid" CHECK("recovery_enrollments"."state" IN ('started', 'challenged')),
	CONSTRAINT "recovery_enrollments_expiry_valid" CHECK("recovery_enrollments"."expires_at" > "recovery_enrollments"."created_at"),
	CONSTRAINT "recovery_enrollments_generation_positive" CHECK("recovery_enrollments"."generation" >= 1),
	CONSTRAINT "recovery_enrollments_epoch_positive" CHECK("recovery_enrollments"."registry_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `recovery_enrollments_account_idx` ON `recovery_enrollments` (`account_id`,`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_key_envelopes` (
	`account_id` text NOT NULL,
	`purpose` text NOT NULL,
	`object_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`key_epoch` integer NOT NULL,
	`superseded_at` integer,
	PRIMARY KEY(`account_id`, `purpose`, `object_id`, `recipient_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "key_envelopes_purpose_valid" CHECK("__new_key_envelopes"."purpose" IN ('vault-recovery', 'device-enrollment', 'owned-device')),
	CONSTRAINT "key_envelopes_epoch_positive" CHECK("__new_key_envelopes"."key_epoch" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_key_envelopes`("account_id", "purpose", "object_id", "recipient_id", "ciphertext", "key_epoch", "superseded_at") SELECT "account_id", "purpose", "object_id", "recipient_id", "ciphertext", "key_epoch", "superseded_at" FROM `key_envelopes`;--> statement-breakpoint
DROP TABLE `key_envelopes`;--> statement-breakpoint
ALTER TABLE `__new_key_envelopes` RENAME TO `key_envelopes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_rate_limit_counters` (
	`purpose` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`window_ms` integer NOT NULL,
	`time_epoch` integer NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`purpose`, `scope_type`, `scope_id`, `window_ms`, `time_epoch`),
	CONSTRAINT "rate_limit_counters_purpose_valid" CHECK("__new_rate_limit_counters"."purpose" IN ('registration.challenge', 'registration.success', 'webauthn.sign_in', 'recovery.attempt', 'vault_recovery.start', 'session.refresh', 'public_comment.mutate', 'public_comment.report', 'publication.mutate')),
	CONSTRAINT "rate_limit_counters_scope_valid" CHECK("__new_rate_limit_counters"."scope_type" IN ('global', 'account', 'publication', 'account_publication', 'session', 'recovery_identifier', 'network')),
	CONSTRAINT "rate_limit_counters_purpose_scope_valid" CHECK(("__new_rate_limit_counters"."purpose" IN ('registration.challenge', 'registration.success') AND "__new_rate_limit_counters"."scope_type" IN ('global', 'network'))
        OR ("__new_rate_limit_counters"."purpose" = 'webauthn.sign_in' AND "__new_rate_limit_counters"."scope_type" IN ('global', 'network', 'account'))
        OR ("__new_rate_limit_counters"."purpose" = 'recovery.attempt' AND "__new_rate_limit_counters"."scope_type" IN ('global', 'network', 'recovery_identifier'))
        OR ("__new_rate_limit_counters"."purpose" = 'vault_recovery.start' AND "__new_rate_limit_counters"."scope_type" IN ('global', 'network', 'account'))
        OR ("__new_rate_limit_counters"."purpose" = 'session.refresh' AND "__new_rate_limit_counters"."scope_type" = 'session')
        OR ("__new_rate_limit_counters"."purpose" = 'public_comment.mutate' AND "__new_rate_limit_counters"."scope_type" IN ('global', 'network', 'account', 'publication', 'account_publication'))
        OR ("__new_rate_limit_counters"."purpose" = 'public_comment.report' AND "__new_rate_limit_counters"."scope_type" = 'account')
        OR ("__new_rate_limit_counters"."purpose" = 'publication.mutate' AND "__new_rate_limit_counters"."scope_type" = 'account')),
	CONSTRAINT "rate_limit_counters_scope_id_valid" CHECK(("__new_rate_limit_counters"."scope_type" = 'global' AND "__new_rate_limit_counters"."scope_id" = '*')
        OR ("__new_rate_limit_counters"."scope_type" = 'network' AND length("__new_rate_limit_counters"."scope_id") = 72
          AND substr("__new_rate_limit_counters"."scope_id", 1, 8) = 'network:'
          AND substr("__new_rate_limit_counters"."scope_id", 9) NOT GLOB '*[^a-f0-9]*')
        OR ("__new_rate_limit_counters"."scope_type" = 'session' AND length("__new_rate_limit_counters"."scope_id") = 72
          AND substr("__new_rate_limit_counters"."scope_id", 1, 8) = 'session:'
          AND substr("__new_rate_limit_counters"."scope_id", 9) NOT GLOB '*[^a-f0-9]*')
        OR ("__new_rate_limit_counters"."scope_type" = 'recovery_identifier' AND length("__new_rate_limit_counters"."scope_id") = 84
          AND substr("__new_rate_limit_counters"."scope_id", 1, 20) = 'recovery_identifier:'
          AND substr("__new_rate_limit_counters"."scope_id", 21) NOT GLOB '*[^a-f0-9]*')
        OR ("__new_rate_limit_counters"."scope_type" = 'account_publication' AND length("__new_rate_limit_counters"."scope_id") = 84
          AND substr("__new_rate_limit_counters"."scope_id", 1, 20) = 'account_publication:'
          AND substr("__new_rate_limit_counters"."scope_id", 21) NOT GLOB '*[^a-f0-9]*')
        OR ("__new_rate_limit_counters"."scope_type" = 'account' AND length("__new_rate_limit_counters"."scope_id") = 36
          AND substr("__new_rate_limit_counters"."scope_id", 9, 1) = '-' AND substr("__new_rate_limit_counters"."scope_id", 14, 1) = '-'
          AND substr("__new_rate_limit_counters"."scope_id", 15, 1) = '7' AND substr("__new_rate_limit_counters"."scope_id", 19, 1) = '-'
          AND substr("__new_rate_limit_counters"."scope_id", 20, 1) IN ('8', '9', 'a', 'b')
          AND substr("__new_rate_limit_counters"."scope_id", 24, 1) = '-'
          AND "__new_rate_limit_counters"."scope_id" NOT GLOB '*[^0-9a-f-]*')
        OR ("__new_rate_limit_counters"."scope_type" = 'publication' AND length("__new_rate_limit_counters"."scope_id") = 43
          AND "__new_rate_limit_counters"."scope_id" NOT GLOB '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "rate_limit_counters_window_valid" CHECK("__new_rate_limit_counters"."window_ms" BETWEEN 1 AND 86400000),
	CONSTRAINT "rate_limit_counters_epoch_nonnegative" CHECK("__new_rate_limit_counters"."time_epoch" >= 0),
	CONSTRAINT "rate_limit_counters_count_positive" CHECK("__new_rate_limit_counters"."count" >= 1),
	CONSTRAINT "rate_limit_counters_expiry_matches_window" CHECK("__new_rate_limit_counters"."expires_at" = "__new_rate_limit_counters"."time_epoch" + "__new_rate_limit_counters"."window_ms")
);
--> statement-breakpoint
INSERT INTO `__new_rate_limit_counters`("purpose", "scope_type", "scope_id", "window_ms", "time_epoch", "count", "expires_at") SELECT "purpose", "scope_type", "scope_id", "window_ms", "time_epoch", "count", "expires_at" FROM `rate_limit_counters`;--> statement-breakpoint
DROP TABLE `rate_limit_counters`;--> statement-breakpoint
ALTER TABLE `__new_rate_limit_counters` RENAME TO `rate_limit_counters`;--> statement-breakpoint
CREATE INDEX `rate_limit_counters_expiry_idx` ON `rate_limit_counters` (`expires_at`);--> statement-breakpoint
ALTER TABLE `encryption_devices` ADD `revocation_reason` text;