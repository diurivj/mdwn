CREATE TABLE `public_representations` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`link_id` text NOT NULL,
	`revision` integer NOT NULL,
	`file_revision` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`ciphertext_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`link_id`,`publication_id`) REFERENCES `publication_links`(`id`,`publication_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "public_representations_revision_positive" CHECK("public_representations"."revision" >= 1 AND "public_representations"."file_revision" >= 1),
	CONSTRAINT "public_representations_ciphertext_bounded" CHECK(length("public_representations"."ciphertext") <= 524288 AND "public_representations"."ciphertext_size" = length("public_representations"."ciphertext"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_representations_revision_idx` ON `public_representations` (`publication_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `public_representations_pointer_idx` ON `public_representations` (`id`,`publication_id`,`link_id`);--> statement-breakpoint
CREATE TABLE `publication_authors` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`author_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`link_id` text,
	`revision` integer NOT NULL,
	`ciphertext` blob,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`author_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`link_id`,`publication_id`) REFERENCES `publication_links`(`id`,`publication_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "publication_authors_id_opaque" CHECK(length("publication_authors"."id") = 43 AND "publication_authors"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "publication_authors_ordinal_positive" CHECK("publication_authors"."ordinal" >= 1),
	CONSTRAINT "publication_authors_declaration" CHECK(("publication_authors"."ciphertext" IS NULL AND "publication_authors"."link_id" IS NULL AND "publication_authors"."revision" >= 0)
    OR ("publication_authors"."ciphertext" IS NOT NULL AND "publication_authors"."link_id" IS NOT NULL AND "publication_authors"."revision" >= 1
      AND length("publication_authors"."ciphertext") BETWEEN 1 AND 4096))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_authors_author_idx` ON `publication_authors` (`publication_id`,`author_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_authors_ordinal_idx` ON `publication_authors` (`publication_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `publication_links` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "publication_links_id_opaque" CHECK(length("publication_links"."id") = 43 AND "publication_links"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "publication_links_public_key" CHECK(typeof("publication_links"."public_key") = 'blob' AND length("publication_links"."public_key") = 65
    AND substr("publication_links"."public_key", 1, 1) = X'04')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_links_publication_idx` ON `publication_links` (`publication_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_links_identity_idx` ON `publication_links` (`id`,`publication_id`);--> statement-breakpoint
CREATE TABLE `publication_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`requester_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`file_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "publication_requests_not_owner" CHECK("publication_requests"."requester_id" != "publication_requests"."owner_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_requests_requester_idx` ON `publication_requests` (`file_id`,`requester_id`);--> statement-breakpoint
CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`current_link_id` text,
	`current_representation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`,`file_id`) REFERENCES `files`(`owner_id`,`node_id`) ON UPDATE no action ON DELETE restrict,
	-- Reciprocal current pointers: an active Publication names exactly one of its
	-- own links and one of its own Public representations under that link. Both
	-- rows are created or swapped in the same transaction as the pointer.
	FOREIGN KEY (`current_link_id`,`id`) REFERENCES `publication_links`(`id`,`publication_id`)
	  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY (`current_representation_id`,`id`,`current_link_id`)
	  REFERENCES `public_representations`(`id`,`publication_id`,`link_id`)
	  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "publications_id_opaque" CHECK(length("publications"."id") = 43 AND "publications"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "publications_state_valid" CHECK("publications"."state" IN ('active', 'deleting')),
	CONSTRAINT "publications_state_pointers" CHECK(("publications"."state" = 'active' AND "publications"."current_link_id" IS NOT NULL
      AND "publications"."current_representation_id" IS NOT NULL)
    OR ("publications"."state" = 'deleting' AND "publications"."current_link_id" IS NULL AND "publications"."current_representation_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publications_file_idx` ON `publications` (`file_id`) WHERE "publications"."state" IN ('active', 'deleting');
--> statement-breakpoint
-- A Publication is created active, for a File already in the parent-free File
-- capability format, so every later save of it is a paired, converted save.
CREATE TRIGGER publication_created_active BEFORE INSERT ON publications
WHEN NEW.state != 'active' OR NOT EXISTS (SELECT 1 FROM files
  WHERE node_id = NEW.file_id AND owner_id = NEW.owner_id AND capability_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'invalid publication'); END;
--> statement-breakpoint
CREATE TRIGGER publication_identity_immutable BEFORE UPDATE OF id, file_id, owner_id ON publications
WHEN NEW.id != OLD.id OR NEW.file_id != OLD.file_id OR NEW.owner_id != OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'publication identity immutable'); END;
--> statement-breakpoint
-- A sealed teardown marker can never become an active Publication again.
CREATE TRIGGER publication_seal_irreversible BEFORE UPDATE OF state ON publications
WHEN OLD.state = 'deleting' AND NEW.state != 'deleting'
BEGIN SELECT RAISE(ABORT, 'sealed publication'); END;
--> statement-breakpoint
CREATE TRIGGER publication_link_immutable BEFORE UPDATE ON publication_links
BEGIN SELECT RAISE(ABORT, 'publication link immutable'); END;
--> statement-breakpoint
-- Saves insert a fresh Public representation; they never rewrite one in place.
CREATE TRIGGER public_representation_immutable BEFORE UPDATE ON public_representations
BEGIN SELECT RAISE(ABORT, 'public representation immutable'); END;
--> statement-breakpoint
CREATE TRIGGER publication_author_identity_immutable BEFORE UPDATE OF id, publication_id, author_id, ordinal ON publication_authors
WHEN NEW.id != OLD.id OR NEW.publication_id != OLD.publication_id OR NEW.author_id != OLD.author_id OR NEW.ordinal != OLD.ordinal
BEGIN SELECT RAISE(ABORT, 'publication author immutable'); END;
--> statement-breakpoint
CREATE TRIGGER publication_request_immutable BEFORE UPDATE ON publication_requests
BEGIN SELECT RAISE(ABORT, 'publication request immutable'); END;
