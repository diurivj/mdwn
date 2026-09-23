CREATE TABLE `account_profiles` (
	`account_id` text PRIMARY KEY NOT NULL,
	`ciphertext` blob NOT NULL,
	`revision` integer NOT NULL,
	`epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "account_profiles_revision_positive" CHECK("account_profiles"."revision" >= 1),
	CONSTRAINT "account_profiles_epoch_positive" CHECK("account_profiles"."epoch" >= 1)
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`transports` text NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "passkeys_counter_nonnegative" CHECK("passkeys"."counter" >= 0),
	CONSTRAINT "passkeys_device_type_valid" CHECK("passkeys"."device_type" IN ('singleDevice', 'multiDevice'))
);
--> statement-breakpoint
CREATE INDEX `passkeys_account_id_idx` ON `passkeys` (`account_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`purpose` text NOT NULL,
	`authenticated_passkey_id` text,
	`created_at` integer NOT NULL,
	`idle_expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`fresh_asserted_at` integer,
	`refreshed_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sessions_purpose_valid" CHECK("sessions"."purpose" IN ('normal', 'recovery')),
	CONSTRAINT "sessions_absolute_after_created" CHECK("sessions"."absolute_expires_at" > "sessions"."created_at"),
	CONSTRAINT "sessions_idle_within_absolute" CHECK("sessions"."idle_expires_at" <= "sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE INDEX `sessions_account_live_idx` ON `sessions` (`account_id`,`revoked_at`,`idle_expires_at`,`absolute_expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_authenticated_passkey_idx` ON `sessions` (`authenticated_passkey_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`purpose` text NOT NULL,
	`account_id` text,
	`session_id` text,
	`origin` text NOT NULL,
	`rp_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "webauthn_challenges_purpose_valid" CHECK("webauthn_challenges"."purpose" IN ('sign_in', 'fresh_assertion', 'passkey_registration')),
	CONSTRAINT "webauthn_challenges_expiry_after_created" CHECK("webauthn_challenges"."expires_at" > "webauthn_challenges"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_challenge_unique` ON `webauthn_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expiry_idx` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_session_idx` ON `webauthn_challenges` (`session_id`);