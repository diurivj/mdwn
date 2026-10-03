CREATE TABLE `comment_thread_epochs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`audience` text,
	`key_epoch` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "comment_thread_epochs_audience_valid" CHECK("comment_thread_epochs"."audience" IS NULL OR "comment_thread_epochs"."audience" IN ('public', 'collaborators_only')),
	CONSTRAINT "comment_thread_epochs_epoch_positive" CHECK("comment_thread_epochs"."key_epoch" >= 1),
	CONSTRAINT "comment_thread_epochs_ordinal_positive" CHECK("comment_thread_epochs"."ordinal" >= 1),
	CONSTRAINT "comment_thread_epochs_state_valid" CHECK("comment_thread_epochs"."state" IN ('active', 'retained'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_thread_epochs_current_idx` ON `comment_thread_epochs` (`thread_id`) WHERE "comment_thread_epochs"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `comment_thread_epochs_ordinal_idx` ON `comment_thread_epochs` (`thread_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `comment_thread_epochs_identity_idx` ON `comment_thread_epochs` (`id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`file_id` text NOT NULL,
	`purpose` text NOT NULL,
	`publication_id` text,
	`current_epoch_id` text NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`file_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_epoch_id`,`id`) REFERENCES `comment_thread_epochs`(`id`,`thread_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "comment_threads_purpose_context" CHECK(("comment_threads"."purpose" = 'private' AND "comment_threads"."publication_id" IS NULL)
    OR ("comment_threads"."purpose" = 'public' AND "comment_threads"."publication_id" IS NOT NULL)),
	CONSTRAINT "comment_threads_sequence_positive" CHECK("comment_threads"."next_sequence" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_threads_private_file_idx` ON `comment_threads` (`file_id`) WHERE "comment_threads"."purpose" = 'private';--> statement-breakpoint
CREATE UNIQUE INDEX `comment_threads_public_publication_idx` ON `comment_threads` (`publication_id`) WHERE "comment_threads"."purpose" = 'public';--> statement-breakpoint
CREATE INDEX `comment_threads_owner_idx` ON `comment_threads` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`author_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`revision` integer NOT NULL,
	`body_ciphertext` blob NOT NULL,
	`body_size` integer NOT NULL,
	`content_key_envelope` blob NOT NULL,
	`content_key_epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`author_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thread_id`,`epoch_id`) REFERENCES `comment_thread_epochs`(`thread_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "comments_sequence_positive" CHECK("comments"."sequence" >= 1),
	CONSTRAINT "comments_revision_positive" CHECK("comments"."revision" >= 1),
	CONSTRAINT "comments_epoch_positive" CHECK("comments"."content_key_epoch" >= 1),
	CONSTRAINT "comments_body_bounded" CHECK(length("comments"."body_ciphertext") BETWEEN 1 AND 16384 AND "comments"."body_size" = length("comments"."body_ciphertext")),
	CONSTRAINT "comments_key_envelope_bounded" CHECK(length("comments"."content_key_envelope") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comments_thread_sequence_idx` ON `comments` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `comments_author_idx` ON `comments` (`author_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `key_rotation_comment_items` (
	`job_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_key_envelope` blob NOT NULL,
	PRIMARY KEY(`job_id`, `kind`, `record_id`),
	FOREIGN KEY (`job_id`,`thread_id`) REFERENCES `key_rotation_items`(`job_id`,`object_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "key_rotation_comment_items_kind" CHECK("key_rotation_comment_items"."kind" IN ('comment', 'attribution')),
	CONSTRAINT "key_rotation_comment_items_revision_positive" CHECK("key_rotation_comment_items"."revision" >= 1),
	CONSTRAINT "key_rotation_comment_items_bounded" CHECK(length("key_rotation_comment_items"."content_key_envelope") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE INDEX `key_rotation_comment_items_page_idx` ON `key_rotation_comment_items` (`job_id`,`thread_id`,`kind`,`record_id`);--> statement-breakpoint
CREATE TABLE `thread_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_id` text NOT NULL,
	`epoch_id` text NOT NULL,
	`revision` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`content_key_envelope` blob NOT NULL,
	`content_key_epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thread_id`,`epoch_id`) REFERENCES `comment_thread_epochs`(`thread_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "thread_attributions_revision_positive" CHECK("thread_attributions"."revision" >= 1),
	CONSTRAINT "thread_attributions_epoch_positive" CHECK("thread_attributions"."content_key_epoch" >= 1),
	CONSTRAINT "thread_attributions_bounded" CHECK(length("thread_attributions"."ciphertext") BETWEEN 1 AND 4096 AND length("thread_attributions"."content_key_envelope") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_attributions_author_idx` ON `thread_attributions` (`thread_id`,`author_id`);