DROP INDEX `directory_entries_parent_idx`;--> statement-breakpoint
CREATE INDEX `directory_entries_parent_idx` ON `directory_entries` (`parent_node_id`,`owner_id`,`child_node_id`);--> statement-breakpoint
DROP INDEX `vault_nodes_parent_idx`;--> statement-breakpoint
CREATE INDEX `vault_nodes_parent_idx` ON `vault_nodes` (`parent_node_id`,`id`,`owner_id`,`kind`,`import_id`);