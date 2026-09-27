CREATE TABLE `file_device_envelopes` (
	`file_node_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`device_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_key_id` text NOT NULL,
	`content_epoch` integer NOT NULL,
	`registry_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`digest` blob NOT NULL,
	PRIMARY KEY(`file_node_id`, `device_id`),
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`file_node_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "file_device_envelopes_bounded" CHECK("file_device_envelopes"."revision" BETWEEN 1 AND 9007199254740991
    AND "file_device_envelopes"."content_epoch" BETWEEN 1 AND 9007199254740991
    AND "file_device_envelopes"."registry_epoch" BETWEEN 1 AND 9007199254740991
    AND length("file_device_envelopes"."content_key_id") BETWEEN 1 AND 256
    AND length("file_device_envelopes"."ciphertext") BETWEEN 1 AND 16384 AND length("file_device_envelopes"."digest") = 32)
);
--> statement-breakpoint
CREATE INDEX `file_device_envelopes_recipient_idx` ON `file_device_envelopes` (`recipient_id`,`device_id`);--> statement-breakpoint
CREATE TABLE `file_heads` (
	`file_node_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`bytes` blob NOT NULL,
	`digest` blob NOT NULL,
	`signature` blob NOT NULL,
	`signer_device_id` text NOT NULL,
	`receiving_public_key` blob NOT NULL,
	`receiving_key_id` text NOT NULL,
	`receiving_epoch` integer NOT NULL,
	`recipient_set_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`representation_id` text NOT NULL,
	`content_key_id` text NOT NULL,
	`content_epoch` integer NOT NULL,
	`parent_envelope` blob NOT NULL,
	FOREIGN KEY (`signer_device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`file_node_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`file_node_id`,`representation_id`,`revision`) REFERENCES `file_representations`(`owner_id`,`file_node_id`,`id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "file_heads_bounded" CHECK(length("file_heads"."bytes") BETWEEN 1 AND 131072
    AND length("file_heads"."digest") = 32 AND length("file_heads"."signature") = 64
    AND length("file_heads"."receiving_public_key") = 65 AND length("file_heads"."parent_envelope") BETWEEN 1 AND 16384
    AND length("file_heads"."receiving_key_id") BETWEEN 1 AND 256
    AND length("file_heads"."content_key_id") BETWEEN 1 AND 256
    AND length("file_heads"."representation_id") BETWEEN 1 AND 256
    AND "file_heads"."revision" BETWEEN 1 AND 9007199254740991
    AND "file_heads"."receiving_epoch" BETWEEN 1 AND 9007199254740991
    AND "file_heads"."content_epoch" BETWEEN 1 AND 9007199254740991
    AND "file_heads"."recipient_set_version" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `file_write_witnesses` (
	`file_node_id` text PRIMARY KEY NOT NULL,
	`proof_id` text NOT NULL,
	FOREIGN KEY (`file_node_id`) REFERENCES `files`(`node_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "file_write_witnesses_proof_id_bounded" CHECK(length("file_write_witnesses"."proof_id") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE `grant_device_envelopes` (
	`grant_id` text NOT NULL,
	`device_id` text NOT NULL,
	`generation` integer NOT NULL,
	`registry_epoch` integer NOT NULL,
	`target_key_id` text NOT NULL,
	`target_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`digest` blob NOT NULL,
	PRIMARY KEY(`grant_id`, `device_id`),
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grant_device_envelopes_bounded" CHECK("grant_device_envelopes"."generation" BETWEEN 1 AND 9007199254740991
    AND "grant_device_envelopes"."registry_epoch" BETWEEN 1 AND 9007199254740991
    AND "grant_device_envelopes"."target_epoch" BETWEEN 1 AND 9007199254740991
    AND length("grant_device_envelopes"."target_key_id") BETWEEN 1 AND 256
    AND length("grant_device_envelopes"."ciphertext") BETWEEN 1 AND 16384 AND length("grant_device_envelopes"."digest") = 32)
);
--> statement-breakpoint
CREATE INDEX `grant_device_envelopes_device_idx` ON `grant_device_envelopes` (`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX grants_id_owner_recipient_idx ON grants(id, owner_id, recipient_id);
--> statement-breakpoint
CREATE TABLE `provisioning_needs` (
	`grant_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`device_id` text NOT NULL,
	`generation` integer NOT NULL,
	`registry_epoch` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`grant_id`, `device_id`),
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`,`owner_id`,`recipient_id`) REFERENCES `grants`(`id`,`owner_id`,`recipient_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provisioning_needs_bounded" CHECK("provisioning_needs"."generation" BETWEEN 1 AND 9007199254740991
    AND "provisioning_needs"."registry_epoch" BETWEEN 1 AND 9007199254740991
    AND "provisioning_needs"."created_at" BETWEEN 0 AND 9007199254740991
    AND "provisioning_needs"."updated_at" BETWEEN "provisioning_needs"."created_at" AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `provisioning_needs_device_idx` ON `provisioning_needs` (`device_id`);--> statement-breakpoint
CREATE INDEX provisioning_needs_recipient_idx ON provisioning_needs(recipient_id, device_id);
--> statement-breakpoint
CREATE INDEX provisioning_needs_owner_idx ON provisioning_needs(owner_id, grant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX vault_nodes_owner_id_idx ON vault_nodes(owner_id, id);
--> statement-breakpoint
CREATE TABLE `rotation_barriers` (
	`owner_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`epoch` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `target_node_id`),
	FOREIGN KEY (`owner_id`,`target_node_id`) REFERENCES `vault_nodes`(`owner_id`,`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rotation_barriers_epoch_positive" CHECK("rotation_barriers"."epoch" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `share_device_material` (
	`share_id` text NOT NULL,
	`material_revision` integer NOT NULL,
	`device_id` text NOT NULL,
	`registry_epoch` integer NOT NULL,
	`public_key_digest` blob NOT NULL,
	`ciphertext` blob NOT NULL,
	`digest` blob NOT NULL,
	PRIMARY KEY(`share_id`, `device_id`),
	FOREIGN KEY (`share_id`) REFERENCES `share_material`(`share_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`share_id`,`material_revision`) REFERENCES `share_material`(`share_id`,`material_revision`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "share_device_material_bounded" CHECK("share_device_material"."material_revision" BETWEEN 1 AND 9007199254740991
    AND "share_device_material"."registry_epoch" BETWEEN 1 AND 9007199254740991
    AND length("share_device_material"."public_key_digest") = 32
    AND length("share_device_material"."ciphertext") BETWEEN 1 AND 16384
    AND length("share_device_material"."digest") = 32)
);
--> statement-breakpoint
CREATE TABLE `share_material` (
	`share_id` text PRIMARY KEY NOT NULL,
	`material_revision` integer NOT NULL,
	`anticipated_grant_id` text NOT NULL,
	`target_key_id` text NOT NULL,
	`target_epoch` integer NOT NULL,
	`head_digest` blob NOT NULL,
	`registry_epoch` integer NOT NULL,
	`candidate_head` blob,
	`candidate_digest` blob,
	`candidate_signature` blob,
	`candidate_signer_device_id` text,
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_signer_device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "share_material_bounded" CHECK("share_material"."material_revision" BETWEEN 1 AND 9007199254740991
  AND "share_material"."target_epoch" BETWEEN 1 AND 9007199254740991
  AND "share_material"."registry_epoch" BETWEEN 1 AND 9007199254740991
  AND length("share_material"."head_digest") = 32
  AND length("share_material"."target_key_id") BETWEEN 1 AND 256 AND length("share_material"."anticipated_grant_id") BETWEEN 1 AND 256
  AND (("share_material"."candidate_head" IS NULL AND "share_material"."candidate_digest" IS NULL
    AND "share_material"."candidate_signature" IS NULL AND "share_material"."candidate_signer_device_id" IS NULL)
    OR (length("share_material"."candidate_head") BETWEEN 1 AND 131072
      AND length("share_material"."candidate_digest") = 32 AND length("share_material"."candidate_signature") = 64
      AND "share_material"."candidate_signer_device_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX share_material_revision_idx ON share_material(share_id, material_revision);
--> statement-breakpoint
-- Additive only. Rebuilding these tables would lose 0008/0009 reciprocal FKs and triggers.
ALTER TABLE directories ADD COLUMN listing_version INTEGER NOT NULL DEFAULT 1 CHECK (listing_version IN (1, 2));
--> statement-breakpoint
ALTER TABLE directories ADD COLUMN capability_key_id TEXT NOT NULL DEFAULT 'legacy' CHECK (length(capability_key_id) BETWEEN 1 AND 256);
--> statement-breakpoint
ALTER TABLE directories ADD COLUMN capability_epoch INTEGER NOT NULL DEFAULT 1 CHECK (capability_epoch BETWEEN 1 AND 9007199254740991);
--> statement-breakpoint
ALTER TABLE directory_entries ADD COLUMN encoding TEXT NOT NULL DEFAULT 'legacy-file' CHECK (encoding IN ('directory', 'legacy-file', 'receiving-file'));
--> statement-breakpoint
ALTER TABLE directory_entries ADD COLUMN receiving_key_id TEXT CHECK (receiving_key_id IS NULL OR length(receiving_key_id) BETWEEN 1 AND 256);
--> statement-breakpoint
ALTER TABLE directory_entries ADD COLUMN receiving_epoch INTEGER CHECK (receiving_epoch IS NULL OR receiving_epoch BETWEEN 1 AND 9007199254740991);
--> statement-breakpoint
ALTER TABLE directory_entries ADD COLUMN wrap_revision INTEGER CHECK (wrap_revision IS NULL OR wrap_revision BETWEEN 1 AND 9007199254740991);
--> statement-breakpoint
UPDATE directory_entries SET encoding = 'directory' WHERE child_node_id IN (SELECT id FROM vault_nodes WHERE kind = 'directory');
--> statement-breakpoint
CREATE TRIGGER directory_entry_encoding_insert BEFORE INSERT ON directory_entries
WHEN NOT ((NEW.encoding = 'receiving-file' AND NEW.receiving_key_id IS NOT NULL AND NEW.receiving_epoch >= 1 AND NEW.wrap_revision >= 1
  AND (SELECT kind FROM vault_nodes WHERE id = NEW.child_node_id) = 'file'
  AND (SELECT listing_version FROM directories WHERE node_id = NEW.parent_node_id) = 2)
  OR (NEW.encoding = 'legacy-file' AND NEW.receiving_key_id IS NULL AND NEW.receiving_epoch IS NULL AND NEW.wrap_revision IS NULL
    AND (SELECT kind FROM vault_nodes WHERE id = NEW.child_node_id) = 'file')
  OR (NEW.encoding = 'directory' AND NEW.receiving_key_id IS NULL AND NEW.receiving_epoch IS NULL AND NEW.wrap_revision IS NULL
    AND (SELECT kind FROM vault_nodes WHERE id = NEW.child_node_id) = 'directory'))
BEGIN SELECT RAISE(ABORT, 'invalid entry encoding'); END;
--> statement-breakpoint
CREATE TRIGGER directory_entry_encoding_update BEFORE UPDATE ON directory_entries
WHEN NOT ((NEW.encoding = 'receiving-file' AND NEW.receiving_key_id IS NOT NULL AND NEW.receiving_epoch >= 1 AND NEW.wrap_revision >= 1
  AND (SELECT kind FROM vault_nodes WHERE id = NEW.child_node_id) = 'file'
  AND (SELECT listing_version FROM directories WHERE node_id = NEW.parent_node_id) = 2)
  OR (NEW.encoding = 'legacy-file' AND NEW.receiving_key_id IS NULL AND NEW.receiving_epoch IS NULL AND NEW.wrap_revision IS NULL
    AND (SELECT kind FROM vault_nodes WHERE id = NEW.child_node_id) = 'file')
  OR (NEW.encoding = 'directory' AND NEW.receiving_key_id IS NULL AND NEW.receiving_epoch IS NULL AND NEW.wrap_revision IS NULL
    AND (SELECT kind FROM vault_nodes WHERE id = NEW.child_node_id) = 'directory'))
BEGIN SELECT RAISE(ABORT, 'invalid entry encoding'); END;
--> statement-breakpoint
CREATE TRIGGER directory_version_forward BEFORE UPDATE OF listing_version ON directories
WHEN NEW.listing_version < OLD.listing_version OR NEW.listing_version > OLD.listing_version + 1
  OR (NEW.listing_version = 2 AND NEW.entries_revision != OLD.entries_revision + 1)
BEGIN SELECT RAISE(ABORT, 'invalid listing version transition'); END;
--> statement-breakpoint
-- 0009 restricted the Directory signer to its Owner. A current Directory
-- Collaborator may sign a structural commit; previously committed provenance
-- survives later Grant revocation (the Worker checks current authority at CAS).
DROP TRIGGER tree_directory_current_head;
--> statement-breakpoint
CREATE TRIGGER tree_directory_current_head BEFORE UPDATE OF entries_revision ON directories
WHEN NEW.listing_ciphertext IS NULL OR NEW.listing_digest IS NULL
  OR NEW.listing_signature IS NULL OR NEW.listing_device_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM encryption_devices d
    WHERE d.id = NEW.listing_device_id AND (d.account_id = NEW.owner_id OR EXISTS (
      SELECT 1 FROM grants g WHERE g.owner_id = NEW.owner_id AND g.recipient_id = d.account_id
        AND g.target_kind = 'directory')))
BEGIN SELECT RAISE(ABORT, 'invalid current Directory head'); END;
--> statement-breakpoint
CREATE TRIGGER file_head_pointer_guard BEFORE UPDATE OF current_revision, current_representation_id ON files
WHEN EXISTS (SELECT 1 FROM directory_entries e WHERE e.child_node_id = NEW.node_id AND e.encoding = 'receiving-file')
  AND NOT EXISTS (SELECT 1 FROM file_heads h WHERE h.file_node_id = NEW.node_id AND h.owner_id = NEW.owner_id
    AND h.revision = NEW.current_revision AND h.representation_id = NEW.current_representation_id)
BEGIN SELECT RAISE(ABORT, 'File head and pointer disagree'); END;
--> statement-breakpoint
CREATE TRIGGER file_head_signer_owner BEFORE INSERT ON file_heads
WHEN NOT EXISTS (SELECT 1 FROM encryption_devices d WHERE d.id = NEW.signer_device_id AND d.account_id = NEW.owner_id)
  AND NOT EXISTS (SELECT 1 FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id
    WHERE d.id = NEW.signer_device_id AND g.owner_id = NEW.owner_id)
BEGIN SELECT RAISE(ABORT, 'invalid File signer provenance'); END;
--> statement-breakpoint
CREATE TRIGGER file_head_signer_update BEFORE UPDATE ON file_heads
WHEN NOT EXISTS (SELECT 1 FROM encryption_devices d WHERE d.id = NEW.signer_device_id AND d.account_id = NEW.owner_id)
  AND NOT EXISTS (SELECT 1 FROM grants g JOIN encryption_devices d ON d.account_id = g.recipient_id
    WHERE d.id = NEW.signer_device_id AND g.owner_id = NEW.owner_id)
BEGIN SELECT RAISE(ABORT, 'invalid File signer provenance'); END;
--> statement-breakpoint
CREATE TRIGGER file_device_envelope_current BEFORE INSERT ON file_device_envelopes
WHEN NOT EXISTS (SELECT 1 FROM file_heads h JOIN files f ON f.node_id = h.file_node_id
  JOIN encryption_devices d ON d.id = NEW.device_id AND d.account_id = NEW.recipient_id
  JOIN account_encryption_identities registry ON registry.account_id = d.account_id
  JOIN grants g ON g.owner_id = NEW.owner_id AND g.recipient_id = NEW.recipient_id
    AND g.target_node_id = NEW.file_node_id AND g.target_kind = 'file'
  WHERE h.file_node_id = NEW.file_node_id AND h.owner_id = NEW.owner_id
    AND f.current_revision = NEW.revision AND f.current_representation_id = h.representation_id
    AND h.revision = NEW.revision AND h.content_key_id = NEW.content_key_id
    AND h.content_epoch = NEW.content_epoch AND d.state = 'active'
    AND registry.registry_epoch = NEW.registry_epoch)
BEGIN SELECT RAISE(ABORT, 'invalid current direct File envelope'); END;
--> statement-breakpoint
CREATE TRIGGER file_device_envelope_update BEFORE UPDATE ON file_device_envelopes
BEGIN SELECT RAISE(ABORT, 'replace direct File envelopes with a guarded delete/insert'); END;
--> statement-breakpoint
CREATE TRIGGER grant_device_envelope_current BEFORE INSERT ON grant_device_envelopes
WHEN NOT EXISTS (SELECT 1 FROM grants g JOIN directories dir ON dir.node_id = g.target_node_id
  JOIN encryption_devices d ON d.id = NEW.device_id AND d.account_id = g.recipient_id
  JOIN account_encryption_identities registry ON registry.account_id = d.account_id
  WHERE g.id = NEW.grant_id AND g.target_kind = 'directory' AND g.generation = NEW.generation
    AND d.state = 'active' AND registry.registry_epoch = NEW.registry_epoch
    AND dir.capability_key_id = NEW.target_key_id AND dir.capability_epoch = NEW.target_epoch)
BEGIN SELECT RAISE(ABORT, 'invalid current Directory Grant envelope'); END;
--> statement-breakpoint
CREATE TRIGGER share_device_material_current BEFORE INSERT ON share_device_material
WHEN NOT EXISTS (SELECT 1 FROM share_material m JOIN shares s ON s.id = m.share_id
  JOIN encryption_devices d ON d.id = NEW.device_id AND d.account_id = s.recipient_id
  JOIN account_encryption_identities registry ON registry.account_id = s.recipient_id
  WHERE s.id = NEW.share_id AND d.state = 'active' AND m.material_revision = NEW.material_revision
    AND m.registry_epoch = registry.registry_epoch AND NEW.registry_epoch = registry.registry_epoch)
BEGIN SELECT RAISE(ABORT, 'invalid pending recipient device'); END;
--> statement-breakpoint
CREATE TRIGGER provisioning_need_current BEFORE INSERT ON provisioning_needs
WHEN NOT EXISTS (SELECT 1 FROM grants g JOIN encryption_devices d ON d.id = NEW.device_id
  JOIN account_encryption_identities registry ON registry.account_id = d.account_id
  WHERE g.id = NEW.grant_id AND g.owner_id = NEW.owner_id AND g.recipient_id = NEW.recipient_id
    AND g.generation = NEW.generation AND d.account_id = g.recipient_id
    AND d.state = 'active' AND registry.registry_epoch = NEW.registry_epoch)
BEGIN SELECT RAISE(ABORT, 'invalid active provisioning need'); END;