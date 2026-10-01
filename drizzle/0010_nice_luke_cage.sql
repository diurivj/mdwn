-- A fresh server invocation marker lets an authorized tree transaction make
-- multiple/bulk dependent writes without relying on their varying changes() counts.
ALTER TABLE `device_proof_uses` ADD `commit_token` text;
--> statement-breakpoint
DROP TRIGGER tree_node_identity_immutable;
--> statement-breakpoint
CREATE TRIGGER tree_node_identity_immutable BEFORE UPDATE OF id, owner_id, kind, import_id ON vault_nodes
WHEN NEW.id != OLD.id OR NEW.owner_id != OLD.owner_id OR NEW.kind != OLD.kind
  OR NEW.import_id IS NOT OLD.import_id
BEGIN SELECT RAISE(ABORT, 'node identity immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tree_node_root_immutable BEFORE UPDATE OF parent_node_id ON vault_nodes
WHEN OLD.parent_node_id IS NULL OR NEW.parent_node_id IS NULL
BEGIN SELECT RAISE(ABORT, 'root immutable'); END;
--> statement-breakpoint
CREATE TRIGGER tree_node_update_no_cycle BEFORE UPDATE OF parent_node_id ON vault_nodes
WHEN EXISTS (
  WITH RECURSIVE lineage(id) AS (
    SELECT NEW.parent_node_id
    UNION
    SELECT n.parent_node_id FROM vault_nodes n JOIN lineage ancestor ON n.id = ancestor.id
    WHERE n.parent_node_id IS NOT NULL LIMIT 101
  )
  -- Match the 100-edge private path bound; overflow/unrooted ancestry must
  -- never skip a potential cycle beyond a truncated traversal.
  SELECT 1 WHERE (SELECT count(*) FROM lineage) > 100
    OR EXISTS (SELECT 1 FROM lineage WHERE id = NEW.id)
    OR NOT EXISTS (SELECT 1 FROM lineage a JOIN vault_nodes n ON n.id = a.id
      WHERE n.owner_id = NEW.owner_id AND n.parent_node_id IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'invalid node ancestry'); END;
--> statement-breakpoint
DROP TRIGGER tree_entry_immutable;
--> statement-breakpoint
CREATE TRIGGER tree_entry_immutable BEFORE UPDATE OF owner_id, child_node_id ON directory_entries
WHEN NEW.owner_id != OLD.owner_id OR NEW.child_node_id != OLD.child_node_id
BEGIN SELECT RAISE(ABORT, 'edge identity immutable'); END;
--> statement-breakpoint
-- Bounded deletion explicitly removes the circular graph with constraints
-- deferred inside one D1 batch. Keep the hidden root immutable.
DROP TRIGGER tree_directory_no_delete;
--> statement-breakpoint
CREATE TRIGGER tree_directory_no_delete BEFORE DELETE ON directories
WHEN EXISTS (SELECT 1 FROM vault_nodes WHERE id = OLD.node_id AND parent_node_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'root immutable'); END;