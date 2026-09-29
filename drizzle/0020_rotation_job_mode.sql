-- A permission change only re-seals current keys at the new Grant generation; a revoke or
-- leave replaces every key the removed party may hold. Existing pending jobs keep the stronger mode.
ALTER TABLE `sharing_rotation_jobs` ADD COLUMN `mode` text NOT NULL DEFAULT 'rekey'
  CHECK (`mode` IN ('rekey', 'reprovision'));
--> statement-breakpoint
-- A Directory capability epoch only ever advances by exactly one (ticket 19 rotation).
CREATE TRIGGER directory_capability_epoch_forward BEFORE UPDATE OF capability_epoch ON directories
WHEN NEW.capability_epoch != OLD.capability_epoch + 1
BEGIN SELECT RAISE(ABORT, 'directory capability epoch advances by one'); END;
