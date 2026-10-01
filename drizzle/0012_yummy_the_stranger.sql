CREATE TABLE `sharing_write_blocks` (
	`target_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`target_id`,`target_kind`) REFERENCES `vault_nodes`(`owner_id`,`id`,`kind`) ON UPDATE no action ON DELETE restrict
);
