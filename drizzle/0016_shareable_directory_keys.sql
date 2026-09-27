-- Directory capabilities have always used their Directory node ID as their
-- opaque key identity. 0011's legacy default was left in existing rows and
-- in the 0008 root-creation trigger, so a perfectly valid root Grant could
-- never satisfy the current-envelope trigger. No key/ciphertext is changed.
UPDATE directories SET capability_key_id = node_id WHERE capability_key_id = 'legacy';
--> statement-breakpoint
DROP TRIGGER tree_new_account_root;
--> statement-breakpoint
CREATE TRIGGER tree_new_account_root AFTER INSERT ON account_encryption_identities
BEGIN
  INSERT INTO vault_nodes (id, kind, owner_id, parent_node_id, created_at, updated_at)
    SELECT NEW.root_directory_id, 'directory', NEW.account_id, NULL, created_at, updated_at
    FROM accounts WHERE id = NEW.account_id;
  INSERT INTO directories (node_id, owner_id, entries_revision, capability_key_id)
    VALUES (NEW.root_directory_id, NEW.account_id, 1, NEW.root_directory_id);
END;