CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`target_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`permission` text NOT NULL,
	`revision` integer NOT NULL,
	`key_epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`target_id`,`target_kind`) REFERENCES `vault_nodes`(`owner_id`,`id`,`kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grants_permission_valid" CHECK("grants"."permission" IN ('read_only', 'read_write')),
	CONSTRAINT "grants_target_kind_valid" CHECK("grants"."target_kind" IN ('directory', 'file')),
	CONSTRAINT "grants_no_self" CHECK("grants"."owner_id" != "grants"."recipient_id"),
	CONSTRAINT "grants_revision_positive" CHECK("grants"."revision" >= 1),
	CONSTRAINT "grants_epoch_positive" CHECK("grants"."key_epoch" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_relationship_idx` ON `grants` (`owner_id`,`recipient_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `grants_recipient_target_idx` ON `grants` (`recipient_id`,`target_id`,`owner_id`,`target_kind`,`permission`);--> statement-breakpoint
CREATE INDEX `grants_recipient_idx` ON `grants` (`recipient_id`,`id`);--> statement-breakpoint
CREATE INDEX `grants_owner_idx` ON `grants` (`owner_id`,`id`);--> statement-breakpoint
CREATE INDEX `grants_target_idx` ON `grants` (`target_id`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`target_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`target_id`,`target_kind`) REFERENCES `vault_nodes`(`owner_id`,`id`,`kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shares_permission_valid" CHECK("shares"."permission" IN ('read_only', 'read_write')),
	CONSTRAINT "shares_target_kind_valid" CHECK("shares"."target_kind" IN ('directory', 'file')),
	CONSTRAINT "shares_no_self" CHECK("shares"."owner_id" != "shares"."recipient_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_relationship_idx` ON `shares` (`owner_id`,`recipient_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `shares_recipient_idx` ON `shares` (`recipient_id`,`id`);--> statement-breakpoint
CREATE INDEX `shares_owner_idx` ON `shares` (`owner_id`,`id`);--> statement-breakpoint
CREATE INDEX `shares_target_idx` ON `shares` (`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_nodes_owner_target_idx` ON `vault_nodes` (`owner_id`,`id`,`kind`);
--> statement-breakpoint
-- A namespace head may be signed by the Owner or a currently authorized
-- Directory read/write Collaborator. Signature verification and Session/epoch
-- checks remain in the first CAS; this trigger also enforces the storage rule.
DROP TRIGGER tree_directory_current_head;
--> statement-breakpoint
CREATE TRIGGER tree_directory_current_head BEFORE UPDATE OF entries_revision ON directories
WHEN NEW.listing_ciphertext IS NULL OR NEW.listing_digest IS NULL
  OR NEW.listing_signature IS NULL OR NEW.listing_device_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM encryption_devices d WHERE d.id = NEW.listing_device_id AND d.state = 'active'
    AND (d.account_id = NEW.owner_id OR EXISTS (
      WITH RECURSIVE lineage(id, parent_node_id, depth) AS (
        SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = NEW.node_id AND owner_id = NEW.owner_id
        UNION ALL
        SELECT n.id, n.parent_node_id, a.depth + 1 FROM vault_nodes n JOIN lineage a ON n.id = a.parent_node_id
        WHERE n.owner_id = NEW.owner_id AND a.depth < 100
      ) SELECT 1 FROM lineage a JOIN grants g INDEXED BY grants_recipient_target_idx
        ON g.target_id = a.id AND g.recipient_id = d.account_id AND g.owner_id = NEW.owner_id
      WHERE g.target_kind = 'directory' AND g.permission = 'read_write'
        AND EXISTS (SELECT 1 FROM lineage WHERE parent_node_id IS NULL))))
BEGIN SELECT RAISE(ABORT, 'invalid current Directory head'); END;