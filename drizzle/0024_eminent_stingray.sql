CREATE TABLE `public_comment_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`category` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_comment_reports_category_valid" CHECK("public_comment_reports"."category" IN ('spam', 'abuse', 'other')),
	CONSTRAINT "public_comment_reports_retention_bounded" CHECK("public_comment_reports"."expires_at" > "public_comment_reports"."created_at" AND "public_comment_reports"."expires_at" <= "public_comment_reports"."created_at" + 2592000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_comment_reports_reporter_comment_idx` ON `public_comment_reports` (`reporter_id`,`comment_id`);--> statement-breakpoint
CREATE INDEX `public_comment_reports_expiry_idx` ON `public_comment_reports` (`expires_at`);--> statement-breakpoint
CREATE INDEX `public_comment_reports_comment_idx` ON `public_comment_reports` (`comment_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `public_participation_suspensions` (
	`account_id` text PRIMARY KEY NOT NULL,
	`strike_count` integer NOT NULL,
	`reason` text NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "public_participation_suspensions_strike_positive" CHECK("public_participation_suspensions"."strike_count" >= 1),
	CONSTRAINT "public_participation_suspensions_reason_valid" CHECK("public_participation_suspensions"."reason" IN ('repeated_technical_abuse', 'report_pattern')),
	CONSTRAINT "public_participation_suspensions_bounded" CHECK("public_participation_suspensions"."expires_at" > "public_participation_suspensions"."started_at" AND "public_participation_suspensions"."expires_at" <= "public_participation_suspensions"."started_at" + 2592000000)
);
