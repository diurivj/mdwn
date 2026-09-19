CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`share_handle_lookup_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_share_id_unique` ON `accounts` (`share_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_share_handle_lookup_token_unique` ON `accounts` (`share_handle_lookup_token`);