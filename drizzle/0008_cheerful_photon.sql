CREATE TABLE `directories` (
	`node_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`entries_revision` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `vault_nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "directories_revision_positive" CHECK("directories"."entries_revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directories_owner_node_idx` ON `directories` (`owner_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `directory_entries` (
	`child_node_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`parent_node_id` text NOT NULL,
	`name_ciphertext` blob NOT NULL,
	`order_ciphertext` blob NOT NULL,
	`key_envelope` blob NOT NULL,
	FOREIGN KEY (`child_node_id`) REFERENCES `vault_nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`parent_node_id`) REFERENCES `directories`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`child_node_id`,`parent_node_id`) REFERENCES `vault_nodes`(`owner_id`,`id`,`parent_node_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `directory_entries_owner_edge_idx` ON `directory_entries` (`owner_id`,`child_node_id`,`parent_node_id`);--> statement-breakpoint
CREATE INDEX `directory_entries_parent_idx` ON `directory_entries` (`owner_id`,`parent_node_id`);--> statement-breakpoint
CREATE TABLE `file_representations` (
	`id` text PRIMARY KEY NOT NULL,
	`file_node_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_key_id` text NOT NULL,
	`key_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`ciphertext_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`,`file_node_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "file_representations_revision_positive" CHECK("file_representations"."revision" >= 1),
	CONSTRAINT "file_representations_epoch_positive" CHECK("file_representations"."key_epoch" >= 1),
	CONSTRAINT "file_representations_ciphertext_bounded" CHECK(length("file_representations"."ciphertext") <= 524288 AND "file_representations"."ciphertext_size" = length("file_representations"."ciphertext"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_representations_owner_pointer_idx` ON `file_representations` (`owner_id`,`file_node_id`,`id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_representations_file_revision_idx` ON `file_representations` (`file_node_id`,`revision`);--> statement-breakpoint
CREATE TABLE `files` (
	`node_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`current_representation_id` text NOT NULL,
	`current_revision` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `vault_nodes`(`id`) ON UPDATE no action ON DELETE restrict,
	-- Circular current pointer: both rows must exist at transaction commit.
	FOREIGN KEY (`owner_id`,`node_id`,`current_representation_id`,`current_revision`)
	  REFERENCES `file_representations`(`owner_id`,`file_node_id`,`id`,`revision`)
	  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "files_revision_positive" CHECK("files"."current_revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_owner_node_idx` ON `files` (`owner_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `vault_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`parent_node_id` text,
	`import_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	-- A non-root must have one same-Owner Directory parent and exactly one agreeing edge.
	FOREIGN KEY (`owner_id`,`parent_node_id`) REFERENCES `directories`(`owner_id`,`node_id`)
	  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY (`owner_id`,`id`,`parent_node_id`)
	  REFERENCES `directory_entries`(`owner_id`,`child_node_id`,`parent_node_id`)
	  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "vault_nodes_kind_valid" CHECK("vault_nodes"."kind" IN ('directory', 'file')),
	CONSTRAINT "vault_nodes_root_directory" CHECK("vault_nodes"."parent_node_id" IS NOT NULL OR "vault_nodes"."kind" = 'directory'),
	CONSTRAINT "vault_nodes_no_self_parent" CHECK("vault_nodes"."parent_node_id" IS NULL OR "vault_nodes"."parent_node_id" != "vault_nodes"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_nodes_one_root_idx` ON `vault_nodes` (`owner_id`) WHERE "vault_nodes"."parent_node_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_nodes_owner_edge_idx` ON `vault_nodes` (`owner_id`,`id`,`parent_node_id`);--> statement-breakpoint
CREATE INDEX `vault_nodes_parent_idx` ON `vault_nodes` (`parent_node_id`);
--> statement-breakpoint
-- This is an additive migration: existing Account encryption identities already
-- carry the signed-up hidden root ID. Materialize that exact ID before serving tree reads.
INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
  SELECT i.root_directory_id, 'directory', i.account_id, NULL, a.created_at, a.updated_at
  FROM account_encryption_identities i JOIN accounts a ON a.id = i.account_id;
--> statement-breakpoint
INSERT INTO directories (node_id, owner_id, entries_revision)
  SELECT root_directory_id, account_id, 1 FROM account_encryption_identities;
--> statement-breakpoint
CREATE TRIGGER tree_new_account_root AFTER INSERT ON account_encryption_identities
BEGIN
  INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
    SELECT NEW.root_directory_id, 'directory', NEW.account_id, NULL, created_at, updated_at
    FROM accounts WHERE id = NEW.account_id;
  INSERT INTO directories (node_id, owner_id, entries_revision)
    VALUES (NEW.root_directory_id, NEW.account_id, 1);
END;
--> statement-breakpoint
CREATE TRIGGER tree_root_matches_identity BEFORE INSERT ON vault_nodes
WHEN NEW.parent_node_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM account_encryption_identities
  WHERE account_id = NEW.owner_id AND root_directory_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'invalid root'); END;
--> statement-breakpoint
CREATE TRIGGER tree_root_identity_immutable BEFORE UPDATE OF account_id, root_directory_id ON account_encryption_identities
WHEN NEW.account_id != OLD.account_id OR NEW.root_directory_id != OLD.root_directory_id
BEGIN SELECT RAISE(ABORT, 'root identity immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tree_node_identity_immutable BEFORE UPDATE OF id, owner_id, kind, import_id, parent_node_id ON vault_nodes
WHEN NEW.id != OLD.id OR NEW.owner_id != OLD.owner_id OR NEW.kind != OLD.kind
  OR NEW.import_id IS NOT OLD.import_id OR NEW.parent_node_id IS NOT OLD.parent_node_id
BEGIN SELECT RAISE(ABORT, 'node identity immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tree_root_no_delete BEFORE DELETE ON vault_nodes
WHEN OLD.parent_node_id IS NULL
BEGIN SELECT RAISE(ABORT, 'root immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tree_directory_kind BEFORE INSERT ON directories
WHEN NOT EXISTS (SELECT 1 FROM vault_nodes WHERE id = NEW.node_id AND owner_id = NEW.owner_id AND kind = 'directory')
BEGIN SELECT RAISE(ABORT, 'invalid directory'); END;
--> statement-breakpoint
CREATE TRIGGER tree_file_kind BEFORE INSERT ON files
WHEN NOT EXISTS (SELECT 1 FROM vault_nodes WHERE id = NEW.node_id AND owner_id = NEW.owner_id AND kind = 'file')
BEGIN SELECT RAISE(ABORT, 'invalid file'); END;
--> statement-breakpoint
CREATE TRIGGER tree_directory_no_delete BEFORE DELETE ON directories
WHEN EXISTS (SELECT 1 FROM vault_nodes WHERE id = OLD.node_id)
BEGIN SELECT RAISE(ABORT, 'directory node still exists'); END;
--> statement-breakpoint
CREATE TRIGGER tree_directory_identity_immutable BEFORE UPDATE OF node_id, owner_id ON directories
WHEN NEW.node_id != OLD.node_id OR NEW.owner_id != OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'directory identity immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tree_file_identity_immutable BEFORE UPDATE OF node_id, owner_id ON files
WHEN NEW.node_id != OLD.node_id OR NEW.owner_id != OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'file identity immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tree_directory_revision BEFORE UPDATE OF entries_revision ON directories
WHEN NEW.entries_revision != OLD.entries_revision + 1
BEGIN SELECT RAISE(ABORT, 'invalid directory revision'); END;
--> statement-breakpoint
CREATE TRIGGER tree_entry_immutable BEFORE UPDATE OF owner_id, child_node_id, parent_node_id ON directory_entries
WHEN NEW.owner_id != OLD.owner_id OR NEW.child_node_id != OLD.child_node_id OR NEW.parent_node_id != OLD.parent_node_id
BEGIN SELECT RAISE(ABORT, 'edge identity immutable'); END;