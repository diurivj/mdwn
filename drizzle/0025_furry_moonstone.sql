PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_public_comment_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`category` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "public_comment_reports_category_valid" CHECK("__new_public_comment_reports"."category" IN ('spam', 'abuse', 'other')),
	CONSTRAINT "public_comment_reports_retention_bounded" CHECK("__new_public_comment_reports"."expires_at" > "__new_public_comment_reports"."created_at" AND "__new_public_comment_reports"."expires_at" <= "__new_public_comment_reports"."created_at" + 2592000000)
);
--> statement-breakpoint
INSERT INTO `__new_public_comment_reports`("id", "reporter_id", "comment_id", "category", "created_at", "expires_at") SELECT "id", "reporter_id", "comment_id", "category", "created_at", "expires_at" FROM `public_comment_reports`;--> statement-breakpoint
DROP TABLE `public_comment_reports`;--> statement-breakpoint
ALTER TABLE `__new_public_comment_reports` RENAME TO `public_comment_reports`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `public_comment_reports_reporter_comment_idx` ON `public_comment_reports` (`reporter_id`,`comment_id`);--> statement-breakpoint
CREATE INDEX `public_comment_reports_expiry_idx` ON `public_comment_reports` (`expires_at`);--> statement-breakpoint
CREATE INDEX `public_comment_reports_comment_idx` ON `public_comment_reports` (`comment_id`,`created_at`);