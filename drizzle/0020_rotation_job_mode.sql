-- A permission change only re-seals current keys at the new Grant generation; a revoke or
-- leave replaces every key the removed party may hold. Existing pending jobs keep the stronger mode.
ALTER TABLE `sharing_rotation_jobs` ADD COLUMN `mode` text NOT NULL DEFAULT 'rekey'
  CHECK (`mode` IN ('rekey', 'reprovision'));
--> statement-breakpoint
-- A Directory capability epoch only ever advances by exactly one (ticket 19 rotation).
CREATE TRIGGER directory_capability_epoch_forward BEFORE UPDATE OF capability_epoch ON directories
WHEN NEW.capability_epoch != OLD.capability_epoch + 1
BEGIN SELECT RAISE(ABORT, 'directory capability epoch advances by one'); END;
--> statement-breakpoint
-- Rotation re-signs a Grant's offer in place: only an active Owner device may sign it, and the
-- Grant, Shared-as label and Owner copy never change.
CREATE TRIGGER grant_labels_owner_signer_update BEFORE UPDATE ON grant_labels
WHEN NEW.grant_id != OLD.grant_id OR NEW.label_id != OLD.label_id OR NEW.owner_copy != OLD.owner_copy
  OR NOT EXISTS (SELECT 1 FROM grants g JOIN encryption_devices signer
    ON signer.id = NEW.signer_device_id AND signer.account_id = g.owner_id
    WHERE g.id = NEW.grant_id AND signer.state = 'active')
BEGIN SELECT RAISE(ABORT, 'invalid Grant label update'); END;
