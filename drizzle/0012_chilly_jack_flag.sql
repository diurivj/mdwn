CREATE TABLE `share_offers` (
  `share_id` text PRIMARY KEY NOT NULL,
  `label_id` text NOT NULL,
  `owner_copy` blob NOT NULL,
  `bytes` blob NOT NULL,
  `digest` blob NOT NULL,
  `signature` blob NOT NULL,
  `signer_device_id` text NOT NULL,
  FOREIGN KEY (`share_id`) REFERENCES `share_material`(`share_id`) ON DELETE restrict,
  FOREIGN KEY (`signer_device_id`) REFERENCES `encryption_devices`(`id`) ON DELETE restrict,
  CONSTRAINT "share_offers_bounded" CHECK(length(`label_id`) BETWEEN 1 AND 256 AND length(`owner_copy`) BETWEEN 1 AND 4096 AND length(`bytes`) BETWEEN 1 AND 131072 AND length(`digest`) = 32 AND length(`signature`) = 64)
);
--> statement-breakpoint
CREATE TABLE `share_offer_labels` (
  `share_id` text NOT NULL,
  `device_id` text NOT NULL,
  `ciphertext` blob NOT NULL,
  `digest` blob NOT NULL,
  PRIMARY KEY (`share_id`, `device_id`),
  FOREIGN KEY (`share_id`) REFERENCES `share_offers`(`share_id`) ON DELETE restrict,
  FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON DELETE restrict,
  CONSTRAINT "share_offer_labels_bounded" CHECK(length(`ciphertext`) BETWEEN 1 AND 4096 AND length(`digest`) = 32)
);
--> statement-breakpoint
CREATE TABLE `grant_labels` (
  `grant_id` text PRIMARY KEY NOT NULL,
  `label_id` text NOT NULL,
  `owner_copy` blob NOT NULL,
  `offer_bytes` blob NOT NULL,
  `offer_digest` blob NOT NULL,
  `offer_signature` blob NOT NULL,
  `signer_device_id` text NOT NULL,
  FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON DELETE restrict,
  FOREIGN KEY (`signer_device_id`) REFERENCES `encryption_devices`(`id`) ON DELETE restrict,
  CONSTRAINT "grant_labels_bounded" CHECK(length(`label_id`) BETWEEN 1 AND 256 AND length(`owner_copy`) BETWEEN 1 AND 4096 AND length(`offer_bytes`) BETWEEN 1 AND 131072 AND length(`offer_digest`) = 32 AND length(`offer_signature`) = 64)
);
--> statement-breakpoint
CREATE TABLE `grant_label_deliveries` (
  `grant_id` text NOT NULL,
  `device_id` text NOT NULL,
  `registry_epoch` integer NOT NULL,
  `ciphertext` blob NOT NULL,
  `digest` blob NOT NULL,
  PRIMARY KEY (`grant_id`, `device_id`),
  FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON DELETE restrict,
  FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON DELETE restrict,
  CONSTRAINT "grant_label_deliveries_bounded" CHECK(`registry_epoch` BETWEEN 1 AND 9007199254740991 AND length(`ciphertext`) BETWEEN 1 AND 4096 AND length(`digest`) = 32)
);
--> statement-breakpoint
CREATE INDEX `grant_label_deliveries_device_idx` ON `grant_label_deliveries` (`device_id`);
--> statement-breakpoint
CREATE TABLE `grant_retained_material` (
  `grant_id` text NOT NULL,
  `device_id` text NOT NULL,
  `registry_epoch` integer NOT NULL,
  `content_key_id` text NOT NULL,
  `content_epoch` integer NOT NULL,
  `revision` integer NOT NULL,
  `ciphertext` blob NOT NULL,
  `digest` blob NOT NULL,
  PRIMARY KEY (`grant_id`, `device_id`),
  FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON DELETE restrict,
  FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON DELETE restrict,
  CONSTRAINT "grant_retained_material_bounded" CHECK(`registry_epoch` BETWEEN 1 AND 9007199254740991 AND `content_epoch` BETWEEN 1 AND 9007199254740991 AND `revision` BETWEEN 1 AND 9007199254740991 AND length(`content_key_id`) BETWEEN 1 AND 256 AND length(`ciphertext`) BETWEEN 1 AND 16384 AND length(`digest`) = 32)
);
--> statement-breakpoint
CREATE INDEX `grant_retained_material_device_idx` ON `grant_retained_material` (`device_id`);