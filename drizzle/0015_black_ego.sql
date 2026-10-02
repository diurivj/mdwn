CREATE TABLE `provisioning_needs` (
	`grant_id` text NOT NULL,
	`device_id` text NOT NULL,
	`grant_key_epoch` integer NOT NULL,
	PRIMARY KEY(`grant_id`, `device_id`),
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "provisioning_needs_epoch" CHECK("provisioning_needs"."grant_key_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `provisioning_needs_device_idx` ON `provisioning_needs` (`device_id`);
--> statement-breakpoint
-- Membership insertion already changes meta.changes through the epoch trigger;
-- enrollment/recovery correctly test it for nonzero, not exactly one. This adds
-- only non-authorizing opaque work in that same atomic cutover.
CREATE TRIGGER sharing_new_device_need AFTER INSERT ON encryption_devices
WHEN NEW.state = 'active'
BEGIN
  INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
    SELECT id, NEW.id, key_epoch FROM grants WHERE recipient_id = NEW.account_id;
END;
--> statement-breakpoint
-- Comment producers register only opaque identities in their own creation
-- transaction. Existing Grant/device pairs now need this independent material.
CREATE TRIGGER sharing_new_comment_need AFTER INSERT ON sharing_comment_capabilities
BEGIN
  INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
    SELECT g.id, d.id, g.key_epoch FROM grants g
    JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    WHERE g.owner_id = NEW.owner_id AND ((g.target_kind = 'file' AND g.target_id = NEW.file_id)
      OR (g.target_kind = 'directory' AND g.target_id IN (
        WITH RECURSIVE ancestors(id, parent_node_id, depth) AS (
          SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = NEW.file_id AND owner_id = NEW.owner_id
          UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM ancestors a
            JOIN vault_nodes n ON n.id = a.parent_node_id WHERE n.owner_id = NEW.owner_id AND a.depth < 100
        ) SELECT id FROM ancestors)))
    ON CONFLICT (grant_id, device_id) DO NOTHING;
END;
--> statement-breakpoint
-- Context identities never migrate to another File/thread/Publication. A
-- rotation may change only the capability at a strictly newer key epoch.
CREATE TRIGGER sharing_comment_context_immutable BEFORE UPDATE ON sharing_comment_capabilities
WHEN NEW.object_id IS NOT OLD.object_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.file_id IS NOT OLD.file_id
  OR NEW.thread_id IS NOT OLD.thread_id OR NEW.purpose IS NOT OLD.purpose OR NEW.publication_id IS NOT OLD.publication_id
  OR NEW.capability_epoch < OLD.capability_epoch
  OR (NEW.capability_id IS NOT OLD.capability_id AND NEW.capability_epoch <= OLD.capability_epoch)
BEGIN SELECT RAISE(ABORT, 'comment capability context immutable'); END;
--> statement-breakpoint
CREATE TRIGGER sharing_rotated_comment_need AFTER UPDATE OF capability_id, capability_epoch ON sharing_comment_capabilities
WHEN NEW.capability_id IS NOT OLD.capability_id OR NEW.capability_epoch != OLD.capability_epoch
BEGIN
  INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
    SELECT g.id, d.id, g.key_epoch FROM grants g
    JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    WHERE g.owner_id = NEW.owner_id AND ((g.target_kind = 'file' AND g.target_id = NEW.file_id)
      OR (g.target_kind = 'directory' AND g.target_id IN (
        WITH RECURSIVE ancestors(id, parent_node_id, depth) AS (
          SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = NEW.file_id AND owner_id = NEW.owner_id
          UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM ancestors a
            JOIN vault_nodes n ON n.id = a.parent_node_id WHERE n.owner_id = NEW.owner_id AND a.depth < 100
        ) SELECT id FROM ancestors)))
    ON CONFLICT (grant_id, device_id) DO NOTHING;
END;
--> statement-breakpoint
-- Backfill existing missing root deliveries. Comment requirements are newly
-- introduced in the preceding migration and are initially empty on upgrade.
INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
  SELECT s.id, d.id, s.key_epoch FROM grants s
  JOIN encryption_devices d ON d.account_id = s.recipient_id AND d.state = 'active'
  WHERE NOT EXISTS (SELECT 1 FROM grant_key_envelopes e
    WHERE e.relationship_id = s.id AND e.device_id = d.id AND e.grant_key_epoch = s.key_epoch
      AND ((s.target_kind = 'directory' AND e.capability_id = s.target_id AND e.capability_epoch = 1)
        OR (s.target_kind = 'file' AND EXISTS (SELECT 1 FROM files f WHERE f.node_id = s.target_id
          AND f.owner_id = s.owner_id AND f.capability_id = e.capability_id AND f.capability_epoch = e.capability_epoch))));