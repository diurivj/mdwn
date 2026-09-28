CREATE TABLE `comment_thread_device_envelopes` (
	`thread_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`device_id` text NOT NULL,
	`registry_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`digest` blob NOT NULL,
	PRIMARY KEY(`thread_id`, `device_id`),
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thread_id`,`epoch`) REFERENCES `comment_thread_epochs`(`thread_id`,`epoch`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "comment_thread_device_envelopes_bounded" CHECK("comment_thread_device_envelopes"."epoch" BETWEEN 1 AND 9007199254740991
    AND "comment_thread_device_envelopes"."registry_epoch" BETWEEN 1 AND 9007199254740991
    AND length("comment_thread_device_envelopes"."ciphertext") BETWEEN 1 AND 4096 AND length("comment_thread_device_envelopes"."digest") = 32)
);
--> statement-breakpoint
CREATE INDEX `comment_thread_device_envelopes_device_idx` ON `comment_thread_device_envelopes` (`device_id`);--> statement-breakpoint
CREATE TABLE `comment_thread_epochs` (
	`thread_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`key_id` text NOT NULL,
	`receiving_key_id` text NOT NULL,
	`receiving_epoch` integer NOT NULL,
	`receiving_wrapper` blob NOT NULL,
	`previous_wrapper` blob,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `epoch`),
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "comment_thread_epochs_bounded" CHECK("comment_thread_epochs"."epoch" BETWEEN 1 AND 9007199254740991
    AND "comment_thread_epochs"."receiving_epoch" BETWEEN 1 AND 9007199254740991
    AND length("comment_thread_epochs"."key_id") BETWEEN 1 AND 256 AND length("comment_thread_epochs"."receiving_key_id") BETWEEN 1 AND 256
    AND length("comment_thread_epochs"."receiving_wrapper") BETWEEN 1 AND 4096
    AND (("comment_thread_epochs"."epoch" = 1 AND "comment_thread_epochs"."previous_wrapper" IS NULL)
      OR ("comment_thread_epochs"."epoch" > 1 AND length("comment_thread_epochs"."previous_wrapper") BETWEEN 1 AND 4096)))
);
--> statement-breakpoint
CREATE TABLE `comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`file_node_id` text NOT NULL,
	`audience` text NOT NULL,
	`current_epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`file_node_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "comment_threads_bounded" CHECK("comment_threads"."audience" = 'private'
    AND "comment_threads"."current_epoch" BETWEEN 1 AND 9007199254740991 AND "comment_threads"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_threads_private_file_idx` ON `comment_threads` (`file_node_id`) WHERE "comment_threads"."audience" = 'private';--> statement-breakpoint
CREATE UNIQUE INDEX `comment_threads_owner_id_idx` ON `comment_threads` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`revision` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thread_id`,`epoch`) REFERENCES `comment_thread_epochs`(`thread_id`,`epoch`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "comments_bounded" CHECK("comments"."epoch" BETWEEN 1 AND 9007199254740991
    AND "comments"."revision" BETWEEN 1 AND 9007199254740991
    AND length("comments"."ciphertext") BETWEEN 1 AND 9216
    AND "comments"."created_at" >= 0 AND "comments"."updated_at" >= "comments"."created_at")
);
--> statement-breakpoint
CREATE INDEX `comments_thread_order_idx` ON `comments` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `thread_attributions` (
	`thread_id` text NOT NULL,
	`account_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`revision` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `account_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`thread_id`,`epoch`) REFERENCES `comment_thread_epochs`(`thread_id`,`epoch`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "thread_attributions_bounded" CHECK("thread_attributions"."epoch" BETWEEN 1 AND 9007199254740991
    AND "thread_attributions"."revision" BETWEEN 1 AND 9007199254740991
    AND length("thread_attributions"."ciphertext") BETWEEN 1 AND 2048 AND "thread_attributions"."updated_at" >= 0)
);
--> statement-breakpoint
-- A thread keeps its File and audience; its key epoch only moves forward by one.
CREATE TRIGGER comment_threads_identity BEFORE UPDATE ON comment_threads
WHEN NEW.id != OLD.id OR NEW.owner_id != OLD.owner_id OR NEW.file_node_id != OLD.file_node_id
  OR NEW.audience != OLD.audience OR NEW.created_at != OLD.created_at
  OR (NEW.current_epoch != OLD.current_epoch AND NEW.current_epoch != OLD.current_epoch + 1)
BEGIN SELECT RAISE(ABORT, 'invalid comment thread update'); END;
--> statement-breakpoint
CREATE TRIGGER comment_thread_epochs_immutable BEFORE UPDATE ON comment_thread_epochs
WHEN NEW.thread_id != OLD.thread_id OR NEW.epoch != OLD.epoch OR NEW.key_id != OLD.key_id
  OR NEW.previous_wrapper IS NOT OLD.previous_wrapper OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'thread epoch key is immutable'); END;
--> statement-breakpoint
-- Direct device envelopes only for an active device of a current direct File
-- Grant recipient, at the thread's current epoch and current device registry.
CREATE TRIGGER comment_thread_device_envelope_current BEFORE INSERT ON comment_thread_device_envelopes
WHEN NOT EXISTS (SELECT 1 FROM comment_threads t
  JOIN grants g ON g.owner_id = t.owner_id AND g.target_node_id = t.file_node_id
    AND g.target_kind = 'file' AND g.recipient_id = NEW.recipient_id
  JOIN encryption_devices d ON d.id = NEW.device_id AND d.account_id = NEW.recipient_id AND d.state = 'active'
  JOIN account_encryption_identities r ON r.account_id = d.account_id
  WHERE t.id = NEW.thread_id AND t.current_epoch = NEW.epoch AND r.registry_epoch = NEW.registry_epoch)
BEGIN SELECT RAISE(ABORT, 'invalid current thread device envelope'); END;
--> statement-breakpoint
CREATE TRIGGER comment_thread_device_envelope_update BEFORE UPDATE ON comment_thread_device_envelopes
BEGIN SELECT RAISE(ABORT, 'replace thread device envelopes with a guarded delete/insert'); END;
--> statement-breakpoint
-- New and edited Comment bodies and attributions always use the current epoch key.
CREATE TRIGGER comments_current_epoch BEFORE INSERT ON comments
WHEN NOT EXISTS (SELECT 1 FROM comment_threads WHERE id = NEW.thread_id AND current_epoch = NEW.epoch)
  OR NEW.revision != 1
BEGIN SELECT RAISE(ABORT, 'comment must use the current thread epoch'); END;
--> statement-breakpoint
CREATE TRIGGER comments_edit BEFORE UPDATE ON comments
WHEN NEW.id != OLD.id OR NEW.thread_id != OLD.thread_id OR NEW.author_id != OLD.author_id
  OR NEW.created_at != OLD.created_at OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (SELECT 1 FROM comment_threads WHERE id = NEW.thread_id AND current_epoch = NEW.epoch)
BEGIN SELECT RAISE(ABORT, 'invalid comment edit'); END;
--> statement-breakpoint
CREATE TRIGGER thread_attributions_current_insert BEFORE INSERT ON thread_attributions
WHEN NOT EXISTS (SELECT 1 FROM comment_threads WHERE id = NEW.thread_id AND current_epoch = NEW.epoch)
  OR NEW.revision != 1
BEGIN SELECT RAISE(ABORT, 'attribution must use the current thread epoch'); END;
--> statement-breakpoint
CREATE TRIGGER thread_attributions_current_update BEFORE UPDATE ON thread_attributions
WHEN NEW.thread_id != OLD.thread_id OR NEW.account_id != OLD.account_id OR NEW.revision != OLD.revision + 1
  OR NOT EXISTS (SELECT 1 FROM comment_threads WHERE id = NEW.thread_id AND current_epoch = NEW.epoch)
BEGIN SELECT RAISE(ABORT, 'invalid attribution update'); END;
