CREATE TABLE `grant_comment_key_envelopes` (
	`relationship_id` text NOT NULL,
	`device_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`capability_epoch` integer NOT NULL,
	`grant_key_epoch` integer NOT NULL,
	`owner_registry_epoch` integer NOT NULL,
	`recipient_registry_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`signature` blob NOT NULL,
	`signer_device_id` text NOT NULL,
	`object_id` text NOT NULL,
	PRIMARY KEY(`relationship_id`, `object_id`, `device_id`),
	FOREIGN KEY (`relationship_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`signer_device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`object_id`) REFERENCES `sharing_comment_capabilities`(`object_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grant_comment_key_envelopes_bounded" CHECK(length("grant_comment_key_envelopes"."ciphertext") BETWEEN 1 AND 16384 AND length("grant_comment_key_envelopes"."signature") = 64),
	CONSTRAINT "grant_comment_key_envelopes_epochs" CHECK("grant_comment_key_envelopes"."capability_epoch" >= 1 AND "grant_comment_key_envelopes"."grant_key_epoch" >= 1
    AND "grant_comment_key_envelopes"."owner_registry_epoch" >= 1 AND "grant_comment_key_envelopes"."recipient_registry_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `grant_comment_key_envelopes_device_idx` ON `grant_comment_key_envelopes` (`device_id`);--> statement-breakpoint
CREATE INDEX `grant_comment_key_envelopes_object_idx` ON `grant_comment_key_envelopes` (`object_id`);--> statement-breakpoint
CREATE TABLE `share_comment_key_envelopes` (
	`relationship_id` text NOT NULL,
	`device_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`capability_epoch` integer NOT NULL,
	`grant_key_epoch` integer NOT NULL,
	`owner_registry_epoch` integer NOT NULL,
	`recipient_registry_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`signature` blob NOT NULL,
	`signer_device_id` text NOT NULL,
	`object_id` text NOT NULL,
	PRIMARY KEY(`relationship_id`, `object_id`, `device_id`),
	FOREIGN KEY (`relationship_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`signer_device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`object_id`) REFERENCES `sharing_comment_capabilities`(`object_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "share_comment_key_envelopes_bounded" CHECK(length("share_comment_key_envelopes"."ciphertext") BETWEEN 1 AND 16384 AND length("share_comment_key_envelopes"."signature") = 64),
	CONSTRAINT "share_comment_key_envelopes_epochs" CHECK("share_comment_key_envelopes"."capability_epoch" >= 1 AND "share_comment_key_envelopes"."grant_key_epoch" >= 1
    AND "share_comment_key_envelopes"."owner_registry_epoch" >= 1 AND "share_comment_key_envelopes"."recipient_registry_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `share_comment_key_envelopes_device_idx` ON `share_comment_key_envelopes` (`device_id`);--> statement-breakpoint
CREATE INDEX `share_comment_key_envelopes_object_idx` ON `share_comment_key_envelopes` (`object_id`);--> statement-breakpoint
CREATE TABLE `sharing_comment_capabilities` (
	`object_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`file_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`purpose` text NOT NULL,
	`publication_id` text,
	`capability_id` text NOT NULL,
	`capability_epoch` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`file_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sharing_comment_capabilities_context" CHECK(("sharing_comment_capabilities"."purpose" = 'private-comment-thread'
    AND "sharing_comment_capabilities"."publication_id" IS NULL AND "sharing_comment_capabilities"."object_id" = "sharing_comment_capabilities"."thread_id") OR
    ("sharing_comment_capabilities"."purpose" = 'public-comment-audience-epoch' AND "sharing_comment_capabilities"."publication_id" IS NOT NULL)),
	CONSTRAINT "sharing_comment_capabilities_epoch" CHECK("sharing_comment_capabilities"."capability_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `sharing_comment_capabilities_file_idx` ON `sharing_comment_capabilities` (`file_id`,`object_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sharing_comment_capabilities_private_idx` ON `sharing_comment_capabilities` (`file_id`) WHERE "sharing_comment_capabilities"."purpose" = 'private-comment-thread';