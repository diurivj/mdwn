-- 0012's RESTRICT FKs establish existence; these insert guards additionally
-- bind device-scoped ciphertext to the exact recipient Account and current
-- physical device registry. No historical-signature signer-state check on READ.
CREATE TRIGGER share_offer_labels_current BEFORE INSERT ON share_offer_labels
WHEN NOT EXISTS (SELECT 1 FROM share_device_material m
  JOIN shares s ON s.id = m.share_id
  JOIN encryption_devices d ON d.id = m.device_id AND d.account_id = s.recipient_id
  JOIN account_encryption_identities r ON r.account_id = s.recipient_id
  WHERE m.share_id = NEW.share_id AND m.device_id = NEW.device_id
    AND d.state = 'active' AND m.registry_epoch = r.registry_epoch)
BEGIN SELECT RAISE(ABORT, 'invalid pending Share label device'); END;
--> statement-breakpoint
CREATE TRIGGER share_offers_owner_signer BEFORE INSERT ON share_offers
WHEN NOT EXISTS (SELECT 1 FROM shares s JOIN encryption_devices signer
  ON signer.id = NEW.signer_device_id AND signer.account_id = s.owner_id
  WHERE s.id = NEW.share_id AND signer.state = 'active')
BEGIN SELECT RAISE(ABORT, 'invalid Share offer signer'); END;
--> statement-breakpoint
CREATE TRIGGER grant_labels_owner_signer BEFORE INSERT ON grant_labels
WHEN NOT EXISTS (SELECT 1 FROM grants g JOIN encryption_devices signer
  ON signer.id = NEW.signer_device_id AND signer.account_id = g.owner_id
  WHERE g.id = NEW.grant_id AND signer.state = 'active')
BEGIN SELECT RAISE(ABORT, 'invalid Grant label signer'); END;
--> statement-breakpoint
CREATE TRIGGER grant_label_deliveries_current BEFORE INSERT ON grant_label_deliveries
WHEN NOT EXISTS (SELECT 1 FROM grants g JOIN encryption_devices d
  ON d.id = NEW.device_id AND d.account_id = g.recipient_id
  JOIN account_encryption_identities r ON r.account_id = g.recipient_id
  WHERE g.id = NEW.grant_id AND d.state = 'active' AND r.registry_epoch = NEW.registry_epoch)
BEGIN SELECT RAISE(ABORT, 'invalid Grant label device'); END;
--> statement-breakpoint
CREATE TRIGGER grant_retained_material_current BEFORE INSERT ON grant_retained_material
WHEN NEW.public_key_digest IS NULL OR NOT EXISTS (SELECT 1 FROM grants g
  JOIN encryption_devices d ON d.id = NEW.device_id AND d.account_id = g.recipient_id
  JOIN account_encryption_identities r ON r.account_id = g.recipient_id
  JOIN file_heads h ON h.file_node_id = g.target_node_id AND h.owner_id = g.owner_id
  JOIN files f ON f.node_id = h.file_node_id AND f.owner_id = h.owner_id
  WHERE g.id = NEW.grant_id AND g.target_kind = 'file' AND d.state = 'active'
    AND r.registry_epoch = NEW.registry_epoch AND f.current_revision = h.revision
    AND f.current_representation_id = h.representation_id
    AND NEW.content_key_id = h.content_key_id AND NEW.content_epoch = h.content_epoch
    AND NEW.revision = h.revision)
BEGIN SELECT RAISE(ABORT, 'invalid retained File-key device'); END;