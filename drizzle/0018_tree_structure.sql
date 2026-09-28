CREATE TABLE `tree_teardown_nodes` (
	`node_id` text PRIMARY KEY NOT NULL,
	`invocation_id` text NOT NULL,
	`owner_id` text NOT NULL,
	CONSTRAINT "tree_teardown_nodes_bounded" CHECK(length("tree_teardown_nodes"."invocation_id") = 36
    AND length("tree_teardown_nodes"."node_id") BETWEEN 1 AND 256 AND length("tree_teardown_nodes"."owner_id") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE INDEX `tree_teardown_nodes_invocation_idx` ON `tree_teardown_nodes` (`invocation_id`);--> statement-breakpoint
-- Ticket 16 moves change a node's parent (never to or from the hidden root).
-- The move batch replaces the directory_entries edge with a guarded
-- delete/insert: vault_nodes -> directory_entries is deferred, while the
-- reverse edge FK is immediate, so an in-place parent update cannot agree.
DROP TRIGGER tree_node_identity_immutable;
--> statement-breakpoint
CREATE TRIGGER tree_node_identity_immutable BEFORE UPDATE OF id, owner_id, kind, import_id, parent_node_id ON vault_nodes
WHEN NEW.id != OLD.id OR NEW.owner_id != OLD.owner_id OR NEW.kind != OLD.kind
  OR NEW.import_id IS NOT OLD.import_id
  OR (NEW.parent_node_id IS NULL) != (OLD.parent_node_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'node identity immutable'); END;
--> statement-breakpoint
-- A move may not make a node its own ancestor. UNION deduplicates IDs so an
-- existing malformed chain cannot loop forever.
CREATE TRIGGER tree_node_no_cycle_move BEFORE UPDATE OF parent_node_id ON vault_nodes
WHEN NEW.parent_node_id IS NOT NULL AND NEW.parent_node_id IS NOT OLD.parent_node_id AND EXISTS (
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
-- Hard deletion is explicit and bounded: a node, its File row or its
-- Directory namespace may be removed only while the same batch holds its
-- transient teardown marker. The root remains undeletable (0008).
DROP TRIGGER tree_directory_no_delete;
--> statement-breakpoint
CREATE TRIGGER tree_directory_no_delete BEFORE DELETE ON directories
WHEN EXISTS (SELECT 1 FROM vault_nodes WHERE id = OLD.node_id)
  AND NOT EXISTS (SELECT 1 FROM tree_teardown_nodes t
    WHERE t.node_id = OLD.node_id AND t.owner_id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'directory node still exists'); END;
--> statement-breakpoint
CREATE TRIGGER tree_file_teardown_only BEFORE DELETE ON files
WHEN NOT EXISTS (SELECT 1 FROM tree_teardown_nodes t
  WHERE t.node_id = OLD.node_id AND t.owner_id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'File deletion requires teardown'); END;
--> statement-breakpoint
CREATE TRIGGER tree_node_teardown_only BEFORE DELETE ON vault_nodes
WHEN NOT EXISTS (SELECT 1 FROM tree_teardown_nodes t
  WHERE t.node_id = OLD.id AND t.owner_id = OLD.owner_id)
BEGIN SELECT RAISE(ABORT, 'node deletion requires teardown'); END;
