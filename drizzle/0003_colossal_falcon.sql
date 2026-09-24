CREATE TABLE `account_encryption_identities` (
	`account_id` text PRIMARY KEY NOT NULL,
	`root_directory_id` text NOT NULL,
	`registry_epoch` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "account_encryption_epoch_positive" CHECK("account_encryption_identities"."registry_epoch" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_encryption_identities_root_directory_id_unique` ON `account_encryption_identities` (`root_directory_id`);--> statement-breakpoint
CREATE TABLE `authentication_recovery_codes` (
	`account_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`code_hash` blob NOT NULL,
	PRIMARY KEY(`account_id`, `ordinal`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "authentication_recovery_ordinal_valid" CHECK("authentication_recovery_codes"."ordinal" BETWEEN 0 AND 9)
);
--> statement-breakpoint
CREATE TABLE `device_proof_uses` (
	`account_id` text NOT NULL,
	`proof_id` text NOT NULL,
	`session_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `proof_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `device_proof_uses_expiry_idx` ON `device_proof_uses` (`expires_at`);--> statement-breakpoint
CREATE TABLE `encryption_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`transport_public_key` blob NOT NULL,
	`assertion_public_key` blob NOT NULL,
	`state` text NOT NULL,
	`approval_provenance` text NOT NULL,
	`registry_epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_proof_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "encryption_devices_state_valid" CHECK("encryption_devices"."state" IN ('active', 'revoked', 'tombstoned')),
	CONSTRAINT "encryption_devices_epoch_positive" CHECK("encryption_devices"."registry_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `encryption_devices_account_idx` ON `encryption_devices` (`account_id`,`state`);--> statement-breakpoint
CREATE TABLE `key_envelopes` (
	`account_id` text NOT NULL,
	`purpose` text NOT NULL,
	`object_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`ciphertext` blob NOT NULL,
	`key_epoch` integer NOT NULL,
	PRIMARY KEY(`account_id`, `purpose`, `object_id`, `recipient_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "key_envelopes_purpose_valid" CHECK("key_envelopes"."purpose" IN ('vault-recovery', 'device-enrollment')),
	CONSTRAINT "key_envelopes_epoch_positive" CHECK("key_envelopes"."key_epoch" >= 1)
);
--> statement-breakpoint
CREATE TABLE `recovery_capsules` (
	`account_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`recovery_salt` blob NOT NULL,
	`ciphertext` blob NOT NULL,
	`verification_public_key` blob NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "recovery_capsules_generation_positive" CHECK("recovery_capsules"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE `registration_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`origin` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_challenges_challenge_unique` ON `registration_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX `registration_challenges_expiry_idx` ON `registration_challenges` (`expires_at`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`account_id` text,
	`session_id` text,
	`origin` text NOT NULL,
	`rp_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`transport_challenge_hash` blob,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "webauthn_challenges_purpose_valid" CHECK("__new_webauthn_challenges"."purpose" IN ('sign_in', 'fresh_assertion', 'passkey_registration', 'signup')),
	CONSTRAINT "webauthn_challenges_expiry_after_created" CHECK("__new_webauthn_challenges"."expires_at" > "__new_webauthn_challenges"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_webauthn_challenges`("id", "challenge", "purpose", "account_id", "session_id", "origin", "rp_id", "expires_at", "created_at", "transport_challenge_hash") SELECT "id", "challenge", "purpose", "account_id", "session_id", "origin", "rp_id", "expires_at", "created_at", NULL FROM `webauthn_challenges`;--> statement-breakpoint
DROP TABLE `webauthn_challenges`;--> statement-breakpoint
ALTER TABLE `__new_webauthn_challenges` RENAME TO `webauthn_challenges`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_challenge_unique` ON `webauthn_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expiry_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_session_idx` ON `webauthn_challenges` (`session_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `device_id` text;