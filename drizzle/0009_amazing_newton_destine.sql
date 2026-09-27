-- Deferred parent/edge FKs permit forward references; reject a cycle when
-- its closing node is inserted, even if both nodes are new in one D1 batch.
-- UNION deduplicates IDs so an existing malformed chain cannot loop forever.
CREATE TRIGGER tree_node_no_cycle BEFORE INSERT ON vault_nodes
WHEN NEW.parent_node_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE lineage(id) AS (
    SELECT NEW.parent_node_id
    UNION
    SELECT n.parent_node_id FROM vault_nodes n JOIN lineage ancestor ON n.id = ancestor.id
    WHERE n.parent_node_id IS NOT NULL
  )
  SELECT 1 FROM lineage WHERE id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'node cycle'); END;
--> statement-breakpoint
-- Signed current Directory listing heads. The initial empty Directory is
-- revision 1 with no head. Every structural CAS installs a signed encrypted
-- commitment to all current entry ciphertexts in the same D1 transaction.
ALTER TABLE directories ADD COLUMN listing_ciphertext BLOB
  CHECK (listing_ciphertext IS NULL OR length(listing_ciphertext) BETWEEN 1 AND 524288);
--> statement-breakpoint
ALTER TABLE directories ADD COLUMN listing_digest BLOB
  CHECK (listing_digest IS NULL OR length(listing_digest) = 32);
--> statement-breakpoint
ALTER TABLE directories ADD COLUMN listing_signature BLOB
  CHECK (listing_signature IS NULL OR length(listing_signature) = 64);
--> statement-breakpoint
ALTER TABLE directories ADD COLUMN listing_device_id TEXT REFERENCES encryption_devices(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX directories_listing_device_idx ON directories(listing_device_id);
--> statement-breakpoint
CREATE TRIGGER tree_directory_initial_head BEFORE INSERT ON directories
WHEN NEW.entries_revision != 1 OR NEW.listing_ciphertext IS NOT NULL
  OR NEW.listing_digest IS NOT NULL OR NEW.listing_signature IS NOT NULL OR NEW.listing_device_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'invalid initial Directory head'); END;
--> statement-breakpoint
CREATE TRIGGER tree_directory_current_head BEFORE UPDATE OF entries_revision ON directories
WHEN NEW.listing_ciphertext IS NULL OR NEW.listing_digest IS NULL
  OR NEW.listing_signature IS NULL OR NEW.listing_device_id IS NULL
  OR NOT EXISTS (SELECT 1 FROM encryption_devices d
    WHERE d.id = NEW.listing_device_id AND d.account_id = NEW.owner_id)
BEGIN SELECT RAISE(ABORT, 'invalid current Directory head'); END;
--> statement-breakpoint
CREATE TRIGGER tree_directory_no_fork BEFORE UPDATE OF listing_ciphertext, listing_digest, listing_signature, listing_device_id ON directories
WHEN NEW.entries_revision = OLD.entries_revision AND (
  NEW.listing_ciphertext IS NOT OLD.listing_ciphertext OR NEW.listing_digest IS NOT OLD.listing_digest
  OR NEW.listing_signature IS NOT OLD.listing_signature OR NEW.listing_device_id IS NOT OLD.listing_device_id)
BEGIN SELECT RAISE(ABORT, 'Directory head immutable at this revision'); END;
--> statement-breakpoint
-- A File save inserts a new bounded encrypted payload and changes the File's
-- current pointer; it never edits a persisted representation in place.
CREATE TRIGGER tree_representation_immutable BEFORE UPDATE ON file_representations
BEGIN SELECT RAISE(ABORT, 'file representation immutable'); END;
