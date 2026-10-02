CREATE TABLE `key_rotation_entries` (
	`job_id` text NOT NULL,
	`directory_id` text NOT NULL,
	`child_id` text NOT NULL,
	`name_ciphertext` blob NOT NULL,
	`order_ciphertext` blob NOT NULL,
	`key_envelope` blob NOT NULL,
	PRIMARY KEY(`job_id`, `directory_id`, `child_id`),
	FOREIGN KEY (`child_id`) REFERENCES `vault_nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`,`directory_id`) REFERENCES `key_rotation_items`(`job_id`,`object_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "key_rotation_entries_bounded" CHECK(length("key_rotation_entries"."name_ciphertext") BETWEEN 1 AND 4096
    AND length("key_rotation_entries"."order_ciphertext") BETWEEN 1 AND 4096 AND length("key_rotation_entries"."key_envelope") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE TABLE `key_rotation_items` (
	`job_id` text NOT NULL,
	`object_id` text NOT NULL,
	`kind` text NOT NULL,
	`file_id` text,
	`depth` integer NOT NULL,
	`state` text DEFAULT 'ready' NOT NULL,
	`source_epoch` integer,
	`target_epoch` integer,
	`capability_id` text,
	`source_revision` integer,
	`source_representation_id` text,
	`resume_envelope` blob,
	`cursor` text,
	PRIMARY KEY(`job_id`, `object_id`),
	FOREIGN KEY (`job_id`) REFERENCES `crypto_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "key_rotation_items_kind" CHECK("key_rotation_items"."kind" IN ('directory', 'file', 'private_comment', 'public_history')),
	CONSTRAINT "key_rotation_items_state" CHECK("key_rotation_items"."state" IN ('ready', 'staging', 'complete')),
	CONSTRAINT "key_rotation_items_depth" CHECK("key_rotation_items"."depth" BETWEEN 0 AND 101),
	CONSTRAINT "key_rotation_items_envelope" CHECK("key_rotation_items"."resume_envelope" IS NULL OR length("key_rotation_items"."resume_envelope") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE INDEX `key_rotation_items_next_idx` ON `key_rotation_items` (`job_id`,`state`,`depth`,`object_id`);--> statement-breakpoint
CREATE TABLE `key_rotation_receipts` (
	`job_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`digest` blob NOT NULL,
	PRIMARY KEY(`job_id`, `operation_id`),
	FOREIGN KEY (`job_id`) REFERENCES `crypto_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "key_rotation_receipts_digest" CHECK(length("key_rotation_receipts"."digest") = 32)
);
--> statement-breakpoint
-- Ticket 17/18 seals already deny writes. Give them Owner-resumable jobs rather
-- than leaving pre-upgrade removals sealed forever. Installed ciphertext stays old.
UPDATE sharing_write_blocks SET key_epoch = max(key_epoch, COALESCE((
  SELECT COALESCE(d.key_epoch, f.capability_epoch, 0) + 1 FROM vault_nodes n
  LEFT JOIN directories d ON d.node_id = n.id LEFT JOIN files f ON f.node_id = n.id
  WHERE n.id = sharing_write_blocks.target_id
), 2));
--> statement-breakpoint
INSERT INTO crypto_jobs (id, account_id, device_id, kind, state, initiating_account_id,
  target_id, key_epoch, progress, created_at, updated_at)
SELECT substr(printf('%012x', b.created_at), 1, 8) || '-' || substr(printf('%012x', b.created_at), 9, 4)
  || '-7' || substr(lower(hex(randomblob(2))), 1, 3)
  || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 1, 3)
  || '-' || lower(hex(randomblob(6))),
  b.owner_id, (SELECT d.id FROM encryption_devices d WHERE d.account_id = b.owner_id
    ORDER BY (d.state = 'active') DESC, d.id LIMIT 1), 'key_rotation', 'pending', b.owner_id,
  b.target_id, b.key_epoch, 0, b.created_at, b.created_at
FROM sharing_write_blocks b
WHERE EXISTS (SELECT 1 FROM encryption_devices d WHERE d.account_id = b.owner_id)
  AND NOT EXISTS (SELECT 1 FROM crypto_jobs j WHERE j.kind = 'key_rotation' AND j.target_id = b.target_id AND j.state = 'pending');
--> statement-breakpoint
INSERT INTO key_rotation_items (job_id, object_id, kind, depth, state)
SELECT j.id, j.target_id, b.target_kind, 0, 'ready' FROM crypto_jobs j
JOIN sharing_write_blocks b ON b.target_id = j.target_id AND b.owner_id = j.account_id
WHERE j.kind = 'key_rotation' AND j.state = 'pending'
  AND NOT EXISTS (SELECT 1 FROM key_rotation_items i WHERE i.job_id = j.id);
