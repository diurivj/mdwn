PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`action_class` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`account_id` text,
	`publication_id` text,
	`size_class` text,
	`proof_state` text NOT NULL,
	`counter_state` text NOT NULL,
	`retry_at` integer,
	`network_bucket` text,
	`network_bucket_expires_at` integer,
	CONSTRAINT "security_events_expiry_after_created" CHECK("__new_security_events"."expires_at" > "__new_security_events"."created_at"),
	CONSTRAINT "security_events_retention_bounded" CHECK("__new_security_events"."expires_at" <= "__new_security_events"."created_at" + 2592000000),
	CONSTRAINT "security_events_action_valid" CHECK("__new_security_events"."action_class" IN ('registration_challenge', 'registration', 'sign_in', 'recovery', 'session_refresh', 'device_removal', 'public_comment', 'public_comment_report', 'publication')),
	CONSTRAINT "security_events_outcome_valid" CHECK("__new_security_events"."outcome" IN ('allow', 'deny')),
	CONSTRAINT "security_events_reason_valid" CHECK("__new_security_events"."reason" IN ('allowed', 'rate_limited', 'honeypot-filled', 'proof_invalid', 'proof_spent', 'policy_denied', 'capacity_exhausted')),
	CONSTRAINT "security_events_size_class_valid" CHECK("__new_security_events"."size_class" IS NULL OR "__new_security_events"."size_class" IN ('unknown', 'zero', 'under_1_kib', '1_to_4_kib', '4_to_16_kib', 'over_16_kib')),
	CONSTRAINT "security_events_proof_state_valid" CHECK("__new_security_events"."proof_state" IN ('not_applicable', 'issued', 'valid', 'invalid', 'spent')),
	CONSTRAINT "security_events_counter_state_valid" CHECK("__new_security_events"."counter_state" IN ('not_checked', 'allowed', 'denied')),
	CONSTRAINT "security_events_account_id_opaque" CHECK("__new_security_events"."account_id" IS NULL OR (length("__new_security_events"."account_id") = 36
        AND substr("__new_security_events"."account_id", 9, 1) = '-' AND substr("__new_security_events"."account_id", 14, 1) = '-'
        AND substr("__new_security_events"."account_id", 15, 1) = '7' AND substr("__new_security_events"."account_id", 19, 1) = '-'
        AND substr("__new_security_events"."account_id", 20, 1) IN ('8', '9', 'a', 'b')
        AND substr("__new_security_events"."account_id", 24, 1) = '-'
        AND "__new_security_events"."account_id" NOT GLOB '*[^0-9a-f-]*')),
	CONSTRAINT "security_events_publication_id_opaque" CHECK("__new_security_events"."publication_id" IS NULL OR (length("__new_security_events"."publication_id") = 43
        AND "__new_security_events"."publication_id" NOT GLOB '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "security_events_network_bucket_bounded" CHECK(("__new_security_events"."network_bucket" IS NULL AND "__new_security_events"."network_bucket_expires_at" IS NULL)
        OR ("__new_security_events"."network_bucket" IS NOT NULL AND length("__new_security_events"."network_bucket") = 72
          AND substr("__new_security_events"."network_bucket", 1, 8) = 'network:'
          AND substr("__new_security_events"."network_bucket", 9) NOT GLOB '*[^a-f0-9]*'
          AND "__new_security_events"."network_bucket_expires_at" >= "__new_security_events"."created_at"
          AND "__new_security_events"."network_bucket_expires_at" <= "__new_security_events"."created_at" + 86400000
          AND "__new_security_events"."network_bucket_expires_at" <= "__new_security_events"."expires_at"))
);
--> statement-breakpoint
INSERT INTO `__new_security_events`("id", "created_at", "expires_at", "action_class", "outcome", "reason", "account_id", "publication_id", "size_class", "proof_state", "counter_state", "retry_at", "network_bucket", "network_bucket_expires_at") SELECT "id", "created_at", "expires_at", "action_class", "outcome", "reason", "account_id", "publication_id", "size_class", "proof_state", "counter_state", "retry_at", "network_bucket", "network_bucket_expires_at" FROM `security_events`;--> statement-breakpoint
DROP TABLE `security_events`;--> statement-breakpoint
ALTER TABLE `__new_security_events` RENAME TO `security_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `security_events_expiry_idx` ON `security_events` (`expires_at`);--> statement-breakpoint
CREATE INDEX `security_events_network_expiry_idx` ON `security_events` (`network_bucket_expires_at`);--> statement-breakpoint
CREATE INDEX `security_events_account_created_idx` ON `security_events` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `security_events_publication_created_idx` ON `security_events` (`publication_id`,`created_at`);