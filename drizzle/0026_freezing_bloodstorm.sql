CREATE TABLE `import_chunks` (
	`import_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`payload` blob NOT NULL,
	`digest` blob NOT NULL,
	`body_digest` blob NOT NULL,
	`descriptor_count` integer NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`import_id`, `sequence`),
	FOREIGN KEY (`import_id`) REFERENCES `import_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_chunks_sequence_bounded" CHECK("import_chunks"."sequence" BETWEEN 0 AND 39),
	CONSTRAINT "import_chunks_payload_bounded" CHECK(length("import_chunks"."payload") BETWEEN 1 AND 524288),
	CONSTRAINT "import_chunks_digest" CHECK(length("import_chunks"."digest") = 32 AND length("import_chunks"."body_digest") = 32),
	CONSTRAINT "import_chunks_descriptors_bounded" CHECK("import_chunks"."descriptor_count" BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE `import_comment_envelopes` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`capability_id` text NOT NULL,
	`capability_epoch` integer NOT NULL,
	`key_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_comment_envelopes_bounded" CHECK(length("import_comment_envelopes"."ciphertext") BETWEEN 1 AND 16384
      AND "import_comment_envelopes"."capability_epoch" >= 1 AND "import_comment_envelopes"."key_epoch" >= 1)
);
--> statement-breakpoint
CREATE INDEX `import_comment_envelopes_file_idx` ON `import_comment_envelopes` (`file_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `import_commits` (
	`import_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`target_directory_id` text NOT NULL,
	`committed_at` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `import_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_commits_target_opaque" CHECK(length("import_commits"."target_directory_id") = 36)
);
--> statement-breakpoint
CREATE INDEX `import_commits_account_idx` ON `import_commits` (`account_id`,`committed_at`);--> statement-breakpoint
CREATE TABLE `import_records` (
	`import_id` text NOT NULL,
	`chunk_sequence` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`ref1` text,
	`ref2` text,
	`ref3` text,
	`ref4` text,
	`payload` blob NOT NULL,
	`digest` blob NOT NULL,
	`header_key_id` text,
	`header_key_epoch` integer,
	`header_revision` integer,
	`expected_revision` integer,
	`display_sequence` integer,
	`timestamp_created` integer,
	`timestamp_updated` integer,
	`head_device_id` text,
	`signer_device_id` text,
	PRIMARY KEY(`import_id`, `chunk_sequence`, `ordinal`),
	FOREIGN KEY (`import_id`) REFERENCES `import_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_records_kind_valid" CHECK("import_records"."kind" IN (
      'node-directory', 'node-file', 'entry-name', 'entry-order', 'directory-capability', 'file-capability',
      'entry-key', 'representation-key', 'representation', 'file-head', 'replace', 'public-representation',
      'comment-thread', 'comment-meta', 'comment-body', 'comment-key', 'comment-attribution', 'comment-attribution-key',
      'listing-ciphertext', 'listing-digest', 'listing-signature')),
	CONSTRAINT "import_records_ordinal_bounded" CHECK("import_records"."ordinal" BETWEEN 0 AND 49),
	CONSTRAINT "import_records_digest" CHECK(length("import_records"."digest") = 32),
	CONSTRAINT "import_records_payload_bounded" CHECK(
      ("import_records"."kind" IN ('node-directory', 'node-file') AND length("import_records"."payload") = 0)
      OR ("import_records"."kind" IN ('entry-name', 'entry-order', 'comment-attribution') AND length("import_records"."payload") BETWEEN 1 AND 4096)
      OR ("import_records"."kind" IN ('directory-capability', 'file-capability', 'entry-key', 'representation-key',
        'comment-thread', 'comment-body', 'comment-key', 'comment-attribution-key') AND length("import_records"."payload") BETWEEN 1 AND 16384)
      OR ("import_records"."kind" IN ('representation', 'public-representation', 'listing-ciphertext') AND length("import_records"."payload") BETWEEN 1 AND 524288)
      OR ("import_records"."kind" = 'file-head' AND length("import_records"."payload") = 96)
      OR ("import_records"."kind" = 'replace' AND length("import_records"."payload") = 8)
      OR ("import_records"."kind" = 'comment-meta' AND length("import_records"."payload") = 20)
      OR ("import_records"."kind" = 'listing-digest' AND length("import_records"."payload") = 32)
      OR ("import_records"."kind" = 'listing-signature' AND length("import_records"."payload") = 64)),
	CONSTRAINT "import_records_refs_bounded" CHECK(
      ("import_records"."ref1" IS NULL OR length("import_records"."ref1") BETWEEN 1 AND 43)
      AND ("import_records"."ref2" IS NULL OR length("import_records"."ref2") BETWEEN 1 AND 43)
      AND ("import_records"."ref3" IS NULL OR length("import_records"."ref3") BETWEEN 1 AND 43)
      AND ("import_records"."ref4" IS NULL OR length("import_records"."ref4") BETWEEN 1 AND 43)),
	CONSTRAINT "import_records_shape" CHECK(
      ("import_records"."kind" IN ('listing-ciphertext', 'listing-digest', 'listing-signature')
        AND "import_records"."ref1" IS NOT NULL AND "import_records"."ref2" IS NULL AND "import_records"."ref3" IS NULL AND "import_records"."ref4" IS NULL)
      OR ("import_records"."kind" IN ('node-directory', 'node-file', 'entry-name', 'entry-order', 'directory-capability',
        'entry-key', 'file-head', 'replace', 'comment-meta', 'comment-body', 'comment-key',
        'comment-attribution', 'comment-attribution-key')
        AND "import_records"."ref1" IS NOT NULL AND "import_records"."ref2" IS NOT NULL AND "import_records"."ref3" IS NULL AND "import_records"."ref4" IS NULL)
      OR ("import_records"."kind" IN ('file-capability', 'representation-key', 'representation', 'public-representation')
        AND "import_records"."ref1" IS NOT NULL AND "import_records"."ref2" IS NOT NULL AND "import_records"."ref3" IS NOT NULL AND "import_records"."ref4" IS NULL)
      OR ("import_records"."kind" = 'comment-thread'
        AND "import_records"."ref1" IS NOT NULL AND "import_records"."ref2" IS NOT NULL AND "import_records"."ref3" IS NOT NULL AND "import_records"."ref4" IS NOT NULL)),
	CONSTRAINT "import_records_header_fields" CHECK(
      ("import_records"."kind" IN ('entry-name', 'entry-order', 'directory-capability', 'file-capability', 'entry-key',
        'representation-key', 'representation', 'public-representation', 'comment-thread', 'comment-body',
        'comment-key', 'comment-attribution', 'comment-attribution-key', 'listing-ciphertext')
        AND "import_records"."header_key_id" IS NOT NULL AND "import_records"."header_key_epoch" IS NOT NULL AND "import_records"."header_key_epoch" >= 1
        AND "import_records"."header_revision" IS NOT NULL AND "import_records"."header_revision" >= 1)
      OR ("import_records"."kind" NOT IN ('entry-name', 'entry-order', 'directory-capability', 'file-capability', 'entry-key',
        'representation-key', 'representation', 'public-representation', 'comment-thread', 'comment-body',
        'comment-key', 'comment-attribution', 'comment-attribution-key', 'listing-ciphertext')
        AND "import_records"."header_key_id" IS NULL AND "import_records"."header_key_epoch" IS NULL AND "import_records"."header_revision" IS NULL)),
	CONSTRAINT "import_records_expected_revision" CHECK(("import_records"."kind" = 'replace' AND "import_records"."expected_revision" >= 1)
      OR ("import_records"."kind" != 'replace' AND "import_records"."expected_revision" IS NULL)),
	CONSTRAINT "import_records_comment_meta" CHECK(
      ("import_records"."kind" = 'comment-meta' AND "import_records"."display_sequence" >= 1
        AND "import_records"."timestamp_created" >= 0 AND "import_records"."timestamp_updated" >= "import_records"."timestamp_created")
      OR ("import_records"."kind" != 'comment-meta' AND "import_records"."display_sequence" IS NULL
        AND "import_records"."timestamp_created" IS NULL AND "import_records"."timestamp_updated" IS NULL)),
	CONSTRAINT "import_records_file_head" CHECK(
      ("import_records"."kind" = 'file-head' AND "import_records"."head_device_id" IS NOT NULL AND "import_records"."signer_device_id" IS NULL)
      OR ("import_records"."kind" = 'listing-signature' AND "import_records"."signer_device_id" IS NOT NULL AND "import_records"."head_device_id" IS NULL)
      OR ("import_records"."kind" NOT IN ('file-head', 'listing-signature')
        AND "import_records"."head_device_id" IS NULL AND "import_records"."signer_device_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `import_records_kind_idx` ON `import_records` (`import_id`,`kind`,`ref1`);--> statement-breakpoint
CREATE TABLE `import_session_kinds` (
	`import_id` text NOT NULL,
	`kind` text NOT NULL,
	`expected_count` integer NOT NULL,
	PRIMARY KEY(`import_id`, `kind`),
	FOREIGN KEY (`import_id`) REFERENCES `import_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_session_kinds_count_bounded" CHECK("import_session_kinds"."expected_count" BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE `import_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`session_id` text NOT NULL,
	`device_id` text NOT NULL,
	`target_directory_id` text NOT NULL,
	`target_owner_id` text NOT NULL,
	`reviewed_entry_revision` integer NOT NULL,
	`manifest_ciphertext` blob NOT NULL,
	`manifest_digest` blob NOT NULL,
	`expected_record_count` integer NOT NULL,
	`expected_chunk_count` integer NOT NULL,
	`expected_payload_bytes` integer NOT NULL,
	`expected_comment_count` integer NOT NULL,
	`aggregate_digest` blob NOT NULL,
	`state` text NOT NULL,
	`uploaded_chunks` integer DEFAULT 0 NOT NULL,
	`uploaded_records` integer DEFAULT 0 NOT NULL,
	`uploaded_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`committed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`device_id`) REFERENCES `encryption_devices`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_sessions_state_valid" CHECK("import_sessions"."state" IN ('open', 'committed', 'failed')),
	CONSTRAINT "import_sessions_revision_positive" CHECK("import_sessions"."reviewed_entry_revision" >= 1),
	CONSTRAINT "import_sessions_manifest_bounded" CHECK(length("import_sessions"."manifest_ciphertext") BETWEEN 1 AND 131072),
	CONSTRAINT "import_sessions_manifest_digest" CHECK(length("import_sessions"."manifest_digest") = 32 AND length("import_sessions"."aggregate_digest") = 32),
	CONSTRAINT "import_sessions_expected_bounded" CHECK("import_sessions"."expected_record_count" BETWEEN 1 AND 2000
      AND "import_sessions"."expected_chunk_count" BETWEEN 1 AND 40
      AND "import_sessions"."expected_payload_bytes" BETWEEN 1 AND 20971520
      AND "import_sessions"."expected_comment_count" BETWEEN 0 AND 1000),
	CONSTRAINT "import_sessions_uploaded_bounded" CHECK("import_sessions"."uploaded_chunks" BETWEEN 0 AND "import_sessions"."expected_chunk_count"
      AND "import_sessions"."uploaded_records" BETWEEN 0 AND "import_sessions"."expected_record_count"
      AND "import_sessions"."uploaded_bytes" BETWEEN 0 AND "import_sessions"."expected_payload_bytes"),
	CONSTRAINT "import_sessions_expiry_bounded" CHECK("import_sessions"."expires_at" > "import_sessions"."created_at"
      AND "import_sessions"."expires_at" <= "import_sessions"."created_at" + 86400000),
	CONSTRAINT "import_sessions_commit_state" CHECK(("import_sessions"."state" = 'committed' AND "import_sessions"."committed_at" IS NOT NULL)
      OR ("import_sessions"."state" != 'committed' AND "import_sessions"."committed_at" IS NULL)),
	CONSTRAINT "import_sessions_id_opaque" CHECK(length("import_sessions"."id") = 43 AND "import_sessions"."id" NOT GLOB '*[^A-Za-z0-9_-]*')
);
--> statement-breakpoint
CREATE INDEX `import_sessions_account_state_idx` ON `import_sessions` (`account_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `import_sessions_expiry_idx` ON `import_sessions` (`expires_at`,`id`);--> statement-breakpoint
CREATE TRIGGER import_commits_immutable BEFORE UPDATE ON import_commits
BEGIN SELECT RAISE(ABORT, 'import commit immutable'); END;
