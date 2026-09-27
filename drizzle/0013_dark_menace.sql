CREATE TABLE `sharing_write_witnesses` (
	`invocation_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`proof_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "sharing_write_witnesses_ids_bounded" CHECK(length("sharing_write_witnesses"."invocation_id") = 36
  AND length("sharing_write_witnesses"."proof_id") BETWEEN 1 AND 256)
);
