-- Additive conversion support: preserve populated legacy rows, deferred File
-- pointer constraints, and existing authority/namespace triggers. No rebuilds
-- or foreign-key disabling; legacy format is the all-null capability/head state.
ALTER TABLE `files` ADD `capability_id` text;
--> statement-breakpoint
ALTER TABLE `files` ADD `capability_epoch` integer CONSTRAINT `files_capability_pair` CHECK (
  (`capability_id` IS NULL AND `capability_epoch` IS NULL) OR
  (`capability_id` IS NOT NULL AND `capability_epoch` IS NOT NULL AND `capability_epoch` >= 1)
);
--> statement-breakpoint
ALTER TABLE `file_representations` ADD `key_envelope` blob;
--> statement-breakpoint
ALTER TABLE `file_representations` ADD `head_digest` blob;
--> statement-breakpoint
ALTER TABLE `file_representations` ADD `head_signature` blob;
--> statement-breakpoint
ALTER TABLE `file_representations` ADD `head_device_id` text REFERENCES `encryption_devices`(`id`) ON DELETE RESTRICT
  CONSTRAINT `file_representations_head_complete` CHECK (
    (`key_envelope` IS NULL AND `head_digest` IS NULL AND `head_signature` IS NULL AND `head_device_id` IS NULL) OR
    (`key_envelope` IS NOT NULL AND length(`key_envelope`) BETWEEN 1 AND 16384
      AND `head_digest` IS NOT NULL AND length(`head_digest`) = 32
      AND `head_signature` IS NOT NULL AND length(`head_signature`) = 64 AND `head_device_id` IS NOT NULL)
  );
--> statement-breakpoint
-- Representation content and identity remain immutable. Only the first
-- browser conversion may attach its wrapping/head fields to a pinned current
-- legacy representation; subsequent saves/rotations must insert fresh rows.
DROP TRIGGER tree_representation_immutable;
--> statement-breakpoint
CREATE TRIGGER tree_representation_immutable BEFORE UPDATE ON file_representations
WHEN NEW.id IS NOT OLD.id OR NEW.file_node_id IS NOT OLD.file_node_id OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.revision IS NOT OLD.revision OR NEW.content_key_id IS NOT OLD.content_key_id
  OR NEW.key_epoch IS NOT OLD.key_epoch OR NEW.ciphertext IS NOT OLD.ciphertext
  OR NEW.ciphertext_size IS NOT OLD.ciphertext_size OR NEW.created_at IS NOT OLD.created_at
  OR OLD.key_envelope IS NOT NULL OR OLD.head_digest IS NOT NULL OR OLD.head_signature IS NOT NULL OR OLD.head_device_id IS NOT NULL
  OR NEW.key_envelope IS NULL OR NEW.head_digest IS NULL OR NEW.head_signature IS NULL OR NEW.head_device_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM files f WHERE f.node_id = OLD.file_node_id AND f.owner_id = OLD.owner_id
    AND f.current_representation_id = OLD.id AND f.current_revision = OLD.revision
    AND f.capability_id IS NOT NULL AND f.capability_epoch = 1)
BEGIN SELECT RAISE(ABORT, 'file representation immutable'); END;
--> statement-breakpoint
CREATE TABLE `grant_key_envelopes` (
  `relationship_id` text NOT NULL REFERENCES `grants`(`id`) ON DELETE RESTRICT,
  `device_id` text NOT NULL REFERENCES `encryption_devices`(`id`) ON DELETE RESTRICT,
  `capability_id` text NOT NULL,
  `capability_epoch` integer NOT NULL,
  `grant_key_epoch` integer NOT NULL,
  `owner_registry_epoch` integer NOT NULL,
  `recipient_registry_epoch` integer NOT NULL,
  `ciphertext` blob NOT NULL,
  `signature` blob NOT NULL,
  `signer_device_id` text NOT NULL REFERENCES `encryption_devices`(`id`) ON DELETE RESTRICT,
  PRIMARY KEY (`relationship_id`, `device_id`),
  CONSTRAINT `grant_key_envelopes_bounded` CHECK (length(`ciphertext`) BETWEEN 1 AND 16384 AND length(`signature`) = 64),
  CONSTRAINT `grant_key_envelopes_epochs` CHECK (`capability_epoch` >= 1 AND `grant_key_epoch` >= 1
    AND `owner_registry_epoch` >= 1 AND `recipient_registry_epoch` >= 1)
);
--> statement-breakpoint
CREATE TABLE `share_key_envelopes` (
  `relationship_id` text NOT NULL REFERENCES `shares`(`id`) ON DELETE RESTRICT,
  `device_id` text NOT NULL REFERENCES `encryption_devices`(`id`) ON DELETE RESTRICT,
  `capability_id` text NOT NULL,
  `capability_epoch` integer NOT NULL,
  `grant_key_epoch` integer NOT NULL,
  `owner_registry_epoch` integer NOT NULL,
  `recipient_registry_epoch` integer NOT NULL,
  `ciphertext` blob NOT NULL,
  `signature` blob NOT NULL,
  `signer_device_id` text NOT NULL REFERENCES `encryption_devices`(`id`) ON DELETE RESTRICT,
  PRIMARY KEY (`relationship_id`, `device_id`),
  CONSTRAINT `share_key_envelopes_bounded` CHECK (length(`ciphertext`) BETWEEN 1 AND 16384 AND length(`signature`) = 64),
  CONSTRAINT `share_key_envelopes_epochs` CHECK (`capability_epoch` >= 1 AND `grant_key_epoch` >= 1
    AND `owner_registry_epoch` >= 1 AND `recipient_registry_epoch` >= 1)
);
