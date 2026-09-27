CREATE TABLE `__new_grant_retained_material` (
	`grant_id` text NOT NULL,
	`device_id` text NOT NULL,
	`registry_epoch` integer NOT NULL,
	`content_key_id` text NOT NULL,
	`content_epoch` integer NOT NULL,
	`revision` integer NOT NULL,
	`public_key_digest` blob,
	`ciphertext` blob NOT NULL,
	`digest` blob NOT NULL,
	PRIMARY KEY(`grant_id`, `device_id`),
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grant_retained_material_bounded" CHECK("__new_grant_retained_material"."registry_epoch" BETWEEN 1 AND 9007199254740991
    AND "__new_grant_retained_material"."content_epoch" BETWEEN 1 AND 9007199254740991 AND "__new_grant_retained_material"."revision" BETWEEN 1 AND 9007199254740991
    AND length("__new_grant_retained_material"."content_key_id") BETWEEN 1 AND 256
    AND ("__new_grant_retained_material"."public_key_digest" IS NULL OR length("__new_grant_retained_material"."public_key_digest") = 32)
    AND length("__new_grant_retained_material"."ciphertext") BETWEEN 1 AND 16384 AND length("__new_grant_retained_material"."digest") = 32)
);
--> statement-breakpoint
INSERT INTO `__new_grant_retained_material`("grant_id", "device_id", "registry_epoch", "content_key_id", "content_epoch", "revision", "public_key_digest", "ciphertext", "digest") SELECT "grant_id", "device_id", "registry_epoch", "content_key_id", "content_epoch", "revision", NULL, "ciphertext", "digest" FROM `grant_retained_material`;--> statement-breakpoint
DROP TABLE `grant_retained_material`;--> statement-breakpoint
ALTER TABLE `__new_grant_retained_material` RENAME TO `grant_retained_material`;--> statement-breakpoint
CREATE INDEX `grant_retained_material_device_idx` ON `grant_retained_material` (`device_id`);