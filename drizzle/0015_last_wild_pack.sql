CREATE TABLE `sharing_rotation_jobs` (
	`owner_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`barrier_epoch` integer NOT NULL,
	`state` text NOT NULL,
	`cursor` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `target_node_id`),
	FOREIGN KEY (`owner_id`,`target_node_id`) REFERENCES `rotation_barriers`(`owner_id`,`target_node_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sharing_rotation_jobs_pending" CHECK("sharing_rotation_jobs"."state" = 'pending'
    AND "sharing_rotation_jobs"."barrier_epoch" BETWEEN 1 AND 9007199254740991
    AND "sharing_rotation_jobs"."created_at" >= 0 AND "sharing_rotation_jobs"."updated_at" >= "sharing_rotation_jobs"."created_at")
);
