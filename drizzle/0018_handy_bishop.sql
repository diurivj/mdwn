DROP INDEX `grants_recipient_target_idx`;--> statement-breakpoint
ALTER TABLE `grants` ADD `expires_at` integer;--> statement-breakpoint
CREATE INDEX `grants_expiry_idx` ON `grants` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `grants_owner_expiry_idx` ON `grants` (`owner_id`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `grants_recipient_target_idx` ON `grants` (`recipient_id`,`target_id`,`owner_id`,`target_kind`,`permission`,`expires_at`);
--> statement-breakpoint
-- Match grant-lifetime.server.ts: authorization uses D1's precise millisecond clock.
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
        AND (g.expires_at IS NULL OR g.expires_at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)))
        AND EXISTS (SELECT 1 FROM lineage WHERE parent_node_id IS NULL))))
BEGIN SELECT RAISE(ABORT, 'invalid current Directory head'); END;
--> statement-breakpoint
DROP TRIGGER sharing_new_device_need;
--> statement-breakpoint
CREATE TRIGGER sharing_new_device_need AFTER INSERT ON encryption_devices
WHEN NEW.state = 'active'
BEGIN
  INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
    SELECT id, NEW.id, key_epoch FROM grants WHERE recipient_id = NEW.account_id
      AND (expires_at IS NULL OR expires_at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)));
END;
--> statement-breakpoint
DROP TRIGGER sharing_new_comment_need;
--> statement-breakpoint
CREATE TRIGGER sharing_new_comment_need AFTER INSERT ON sharing_comment_capabilities
BEGIN
  INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
    SELECT g.id, d.id, g.key_epoch FROM grants g
    JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    WHERE g.owner_id = NEW.owner_id
      AND (g.expires_at IS NULL OR g.expires_at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)))
      AND ((g.target_kind = 'file' AND g.target_id = NEW.file_id)
      OR (g.target_kind = 'directory' AND g.target_id IN (
        WITH RECURSIVE ancestors(id, parent_node_id, depth) AS (
          SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = NEW.file_id AND owner_id = NEW.owner_id
          UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM ancestors a
            JOIN vault_nodes n ON n.id = a.parent_node_id WHERE n.owner_id = NEW.owner_id AND a.depth < 100
        ) SELECT id FROM ancestors)))
    ON CONFLICT (grant_id, device_id) DO NOTHING;
END;
--> statement-breakpoint
DROP TRIGGER sharing_rotated_comment_need;
--> statement-breakpoint
CREATE TRIGGER sharing_rotated_comment_need AFTER UPDATE OF capability_id, capability_epoch ON sharing_comment_capabilities
WHEN NEW.capability_id IS NOT OLD.capability_id OR NEW.capability_epoch != OLD.capability_epoch
BEGIN
  INSERT INTO provisioning_needs (grant_id, device_id, grant_key_epoch)
    SELECT g.id, d.id, g.key_epoch FROM grants g
    JOIN encryption_devices d ON d.account_id = g.recipient_id AND d.state = 'active'
    WHERE g.owner_id = NEW.owner_id
      AND (g.expires_at IS NULL OR g.expires_at > (CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)))
      AND ((g.target_kind = 'file' AND g.target_id = NEW.file_id)
      OR (g.target_kind = 'directory' AND g.target_id IN (
        WITH RECURSIVE ancestors(id, parent_node_id, depth) AS (
          SELECT id, parent_node_id, 0 FROM vault_nodes WHERE id = NEW.file_id AND owner_id = NEW.owner_id
          UNION ALL SELECT n.id, n.parent_node_id, a.depth + 1 FROM ancestors a
            JOIN vault_nodes n ON n.id = a.parent_node_id WHERE n.owner_id = NEW.owner_id AND a.depth < 100
        ) SELECT id FROM ancestors)))
    ON CONFLICT (grant_id, device_id) DO NOTHING;
END;