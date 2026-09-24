CREATE TABLE `rate_limit_counters` (
	`purpose` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`window_ms` integer NOT NULL,
	`time_epoch` integer NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`purpose`, `scope_type`, `scope_id`, `window_ms`, `time_epoch`),
	CONSTRAINT "rate_limit_counters_purpose_valid" CHECK("rate_limit_counters"."purpose" IN ('registration.challenge', 'registration.success', 'webauthn.sign_in', 'recovery.attempt', 'session.refresh', 'public_comment.mutate', 'public_comment.report', 'publication.mutate')),
	CONSTRAINT "rate_limit_counters_scope_valid" CHECK("rate_limit_counters"."scope_type" IN ('global', 'account', 'publication', 'account_publication', 'session', 'recovery_identifier', 'network')),
	CONSTRAINT "rate_limit_counters_purpose_scope_valid" CHECK(("rate_limit_counters"."purpose" IN ('registration.challenge', 'registration.success') AND "rate_limit_counters"."scope_type" IN ('global', 'network'))
        OR ("rate_limit_counters"."purpose" = 'webauthn.sign_in' AND "rate_limit_counters"."scope_type" IN ('global', 'network', 'account'))
        OR ("rate_limit_counters"."purpose" = 'recovery.attempt' AND "rate_limit_counters"."scope_type" IN ('global', 'network', 'recovery_identifier'))
        OR ("rate_limit_counters"."purpose" = 'session.refresh' AND "rate_limit_counters"."scope_type" = 'session')
        OR ("rate_limit_counters"."purpose" = 'public_comment.mutate' AND "rate_limit_counters"."scope_type" IN ('global', 'network', 'account', 'publication', 'account_publication'))
        OR ("rate_limit_counters"."purpose" = 'public_comment.report' AND "rate_limit_counters"."scope_type" = 'account')
        OR ("rate_limit_counters"."purpose" = 'publication.mutate' AND "rate_limit_counters"."scope_type" = 'account')),
	CONSTRAINT "rate_limit_counters_scope_id_valid" CHECK(("rate_limit_counters"."scope_type" = 'global' AND "rate_limit_counters"."scope_id" = '*')
        OR ("rate_limit_counters"."scope_type" = 'network' AND length("rate_limit_counters"."scope_id") = 72
          AND substr("rate_limit_counters"."scope_id", 1, 8) = 'network:'
          AND substr("rate_limit_counters"."scope_id", 9) NOT GLOB '*[^a-f0-9]*')
        OR ("rate_limit_counters"."scope_type" = 'session' AND length("rate_limit_counters"."scope_id") = 72
          AND substr("rate_limit_counters"."scope_id", 1, 8) = 'session:'
          AND substr("rate_limit_counters"."scope_id", 9) NOT GLOB '*[^a-f0-9]*')
        OR ("rate_limit_counters"."scope_type" = 'recovery_identifier' AND length("rate_limit_counters"."scope_id") = 84
          AND substr("rate_limit_counters"."scope_id", 1, 20) = 'recovery_identifier:'
          AND substr("rate_limit_counters"."scope_id", 21) NOT GLOB '*[^a-f0-9]*')
        OR ("rate_limit_counters"."scope_type" = 'account_publication' AND length("rate_limit_counters"."scope_id") = 84
          AND substr("rate_limit_counters"."scope_id", 1, 20) = 'account_publication:'
          AND substr("rate_limit_counters"."scope_id", 21) NOT GLOB '*[^a-f0-9]*')
        OR ("rate_limit_counters"."scope_type" = 'account' AND length("rate_limit_counters"."scope_id") = 36
          AND substr("rate_limit_counters"."scope_id", 9, 1) = '-' AND substr("rate_limit_counters"."scope_id", 14, 1) = '-'
          AND substr("rate_limit_counters"."scope_id", 15, 1) = '7' AND substr("rate_limit_counters"."scope_id", 19, 1) = '-'
          AND substr("rate_limit_counters"."scope_id", 20, 1) IN ('8', '9', 'a', 'b')
          AND substr("rate_limit_counters"."scope_id", 24, 1) = '-'
          AND "rate_limit_counters"."scope_id" NOT GLOB '*[^0-9a-f-]*')
        OR ("rate_limit_counters"."scope_type" = 'publication' AND length("rate_limit_counters"."scope_id") = 43
          AND "rate_limit_counters"."scope_id" NOT GLOB '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "rate_limit_counters_window_valid" CHECK("rate_limit_counters"."window_ms" BETWEEN 1 AND 86400000),
	CONSTRAINT "rate_limit_counters_epoch_nonnegative" CHECK("rate_limit_counters"."time_epoch" >= 0),
	CONSTRAINT "rate_limit_counters_count_positive" CHECK("rate_limit_counters"."count" >= 1),
	CONSTRAINT "rate_limit_counters_expiry_matches_window" CHECK("rate_limit_counters"."expires_at" = "rate_limit_counters"."time_epoch" + "rate_limit_counters"."window_ms")
);
--> statement-breakpoint
CREATE INDEX `rate_limit_counters_expiry_idx` ON `rate_limit_counters` (`expires_at`);--> statement-breakpoint
CREATE TABLE `security_events` (
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
	CONSTRAINT "security_events_expiry_after_created" CHECK("security_events"."expires_at" > "security_events"."created_at"),
	CONSTRAINT "security_events_retention_bounded" CHECK("security_events"."expires_at" <= "security_events"."created_at" + 2592000000),
	CONSTRAINT "security_events_action_valid" CHECK("security_events"."action_class" IN ('registration_challenge', 'registration', 'sign_in', 'recovery', 'session_refresh', 'public_comment', 'public_comment_report', 'publication')),
	CONSTRAINT "security_events_outcome_valid" CHECK("security_events"."outcome" IN ('allow', 'deny')),
	CONSTRAINT "security_events_reason_valid" CHECK("security_events"."reason" IN ('allowed', 'rate_limited', 'honeypot-filled', 'proof_invalid', 'proof_spent', 'policy_denied', 'capacity_exhausted')),
	CONSTRAINT "security_events_size_class_valid" CHECK("security_events"."size_class" IS NULL OR "security_events"."size_class" IN ('unknown', 'zero', 'under_1_kib', '1_to_4_kib', '4_to_16_kib', 'over_16_kib')),
	CONSTRAINT "security_events_proof_state_valid" CHECK("security_events"."proof_state" IN ('not_applicable', 'issued', 'valid', 'invalid', 'spent')),
	CONSTRAINT "security_events_counter_state_valid" CHECK("security_events"."counter_state" IN ('not_checked', 'allowed', 'denied')),
	CONSTRAINT "security_events_account_id_opaque" CHECK("security_events"."account_id" IS NULL OR (length("security_events"."account_id") = 36
        AND substr("security_events"."account_id", 9, 1) = '-' AND substr("security_events"."account_id", 14, 1) = '-'
        AND substr("security_events"."account_id", 15, 1) = '7' AND substr("security_events"."account_id", 19, 1) = '-'
        AND substr("security_events"."account_id", 20, 1) IN ('8', '9', 'a', 'b')
        AND substr("security_events"."account_id", 24, 1) = '-'
        AND "security_events"."account_id" NOT GLOB '*[^0-9a-f-]*')),
	CONSTRAINT "security_events_publication_id_opaque" CHECK("security_events"."publication_id" IS NULL OR (length("security_events"."publication_id") = 43
        AND "security_events"."publication_id" NOT GLOB '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "security_events_network_bucket_bounded" CHECK(("security_events"."network_bucket" IS NULL AND "security_events"."network_bucket_expires_at" IS NULL)
        OR ("security_events"."network_bucket" IS NOT NULL AND length("security_events"."network_bucket") = 72
          AND substr("security_events"."network_bucket", 1, 8) = 'network:'
          AND substr("security_events"."network_bucket", 9) NOT GLOB '*[^a-f0-9]*'
          AND "security_events"."network_bucket_expires_at" >= "security_events"."created_at"
          AND "security_events"."network_bucket_expires_at" <= "security_events"."created_at" + 86400000
          AND "security_events"."network_bucket_expires_at" <= "security_events"."expires_at"))
);
--> statement-breakpoint
CREATE INDEX `security_events_expiry_idx` ON `security_events` (`expires_at`);--> statement-breakpoint
CREATE INDEX `security_events_network_expiry_idx` ON `security_events` (`network_bucket_expires_at`);--> statement-breakpoint
CREATE INDEX `security_events_account_created_idx` ON `security_events` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `security_events_publication_created_idx` ON `security_events` (`publication_id`,`created_at`);