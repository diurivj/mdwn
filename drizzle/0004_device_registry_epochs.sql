-- The first signup device starts at epoch 1. Every subsequent active-device
-- insertion and every active-to-inactive transition advances the Account's
-- epoch in the same SQLite statement, regardless of which route changes it.
-- Bulk recovery transitions may advance it more than once, but never less.
CREATE TRIGGER device_registry_active_insert_epoch
BEFORE INSERT ON encryption_devices
WHEN NEW.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'device registry missing')
    WHERE NOT EXISTS (SELECT 1 FROM account_encryption_identities
      WHERE account_id = NEW.account_id);
  SELECT RAISE(ABORT, 'incorrect device registry epoch')
    WHERE NEW.registry_epoch != (
      SELECT registry_epoch FROM account_encryption_identities
      WHERE account_id = NEW.account_id
    ) + (SELECT EXISTS (SELECT 1 FROM encryption_devices
      WHERE account_id = NEW.account_id));
END;
--> statement-breakpoint
CREATE TRIGGER device_registry_active_insert_advance
AFTER INSERT ON encryption_devices
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM encryption_devices
  WHERE account_id = NEW.account_id AND id != NEW.id
)
BEGIN
  UPDATE account_encryption_identities SET registry_epoch = registry_epoch + 1
  WHERE account_id = NEW.account_id;
END;
--> statement-breakpoint
CREATE TRIGGER device_registry_deactivate_advance
AFTER UPDATE OF state ON encryption_devices
WHEN OLD.state = 'active' AND NEW.state != 'active'
BEGIN
  UPDATE account_encryption_identities SET registry_epoch = registry_epoch + 1
  WHERE account_id = OLD.account_id;
END;
--> statement-breakpoint
CREATE TRIGGER device_registry_no_reactivation
BEFORE UPDATE OF state ON encryption_devices
WHEN OLD.state != 'active' AND NEW.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'device reactivation forbidden');
END;
--> statement-breakpoint
CREATE TRIGGER device_registry_no_identity_change
BEFORE UPDATE OF id, account_id ON encryption_devices
WHEN OLD.id != NEW.id OR OLD.account_id != NEW.account_id
BEGIN
  SELECT RAISE(ABORT, 'device identity immutable');
END;
--> statement-breakpoint
-- Device IDs are never reusable: revoked/tombstoned rows are retained, too.
CREATE TRIGGER device_registry_no_device_delete
BEFORE DELETE ON encryption_devices
BEGIN
  SELECT RAISE(ABORT, 'device registry records are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER device_registry_monotonic_epoch
BEFORE UPDATE OF registry_epoch ON account_encryption_identities
WHEN NEW.registry_epoch < OLD.registry_epoch
BEGIN
  SELECT RAISE(ABORT, 'device registry epoch cannot decrease');
END;
