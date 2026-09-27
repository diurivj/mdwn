CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`permission` text NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`target_node_id`,`target_kind`) REFERENCES `vault_nodes`(`owner_id`,`id`,`kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grants_target_kind_valid" CHECK("grants"."target_kind" IN ('file', 'directory')),
	CONSTRAINT "grants_permission_valid" CHECK("grants"."permission" IN ('read_only', 'read_write')),
	CONSTRAINT "grants_not_self" CHECK("grants"."owner_id" != "grants"."recipient_id"),
	CONSTRAINT "grants_generation_positive" CHECK("grants"."generation" >= 1),
	CONSTRAINT "grants_timestamps_valid" CHECK("grants"."created_at" >= 0 AND "grants"."updated_at" >= "grants"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_active_target_recipient_idx` ON `grants` (`owner_id`,`target_node_id`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `grants_recipient_idx` ON `grants` (`recipient_id`,`owner_id`,`target_node_id`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`permission` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`target_node_id`,`target_kind`) REFERENCES `vault_nodes`(`owner_id`,`id`,`kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shares_target_kind_valid" CHECK("shares"."target_kind" IN ('file', 'directory')),
	CONSTRAINT "shares_permission_valid" CHECK("shares"."permission" IN ('read_only', 'read_write')),
	CONSTRAINT "shares_not_self" CHECK("shares"."owner_id" != "shares"."recipient_id"),
	CONSTRAINT "shares_created_nonnegative" CHECK("shares"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_pending_target_recipient_idx` ON `shares` (`owner_id`,`target_node_id`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `shares_recipient_idx` ON `shares` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `vault_nodes_owner_target_kind_idx` ON `vault_nodes` (`owner_id`,`id`,`kind`);
--> statement-breakpoint
-- Keep a pending invitation immutable; cancel/decline removes it, not a status row.
CREATE TRIGGER shares_pending_immutable BEFORE UPDATE ON shares
BEGIN SELECT RAISE(ABORT, 'pending Share immutable'); END;
--> statement-breakpoint
-- A Grant retains its opaque identity across permission changes and every
-- recipient-set/rotation-sensitive change advances its generation exactly once.
CREATE TRIGGER grants_generation_forward BEFORE UPDATE ON grants
WHEN NEW.id != OLD.id OR NEW.owner_id != OLD.owner_id OR NEW.recipient_id != OLD.recipient_id
  OR NEW.target_node_id != OLD.target_node_id OR NEW.target_kind != OLD.target_kind
  OR NEW.created_at != OLD.created_at OR NEW.generation != OLD.generation + 1
  OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'invalid Grant generation'); END;