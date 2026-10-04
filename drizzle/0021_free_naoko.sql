CREATE TABLE `public_comment_epoch_links` (
	`epoch_id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`link_id` text NOT NULL,
	`key_epoch` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`epoch_id`) REFERENCES `comment_thread_epochs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`link_id`) REFERENCES `publication_links`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "public_comment_epoch_links_epoch_positive" CHECK("public_comment_epoch_links"."key_epoch" >= 1),
	CONSTRAINT "public_comment_epoch_links_bounded" CHECK(length("public_comment_epoch_links"."ciphertext") BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE INDEX `public_comment_epoch_links_link_idx` ON `public_comment_epoch_links` (`link_id`,`epoch_id`);--> statement-breakpoint
CREATE INDEX `public_comment_epoch_links_publication_idx` ON `public_comment_epoch_links` (`publication_id`);--> statement-breakpoint
-- A Public thread's current epoch is explicitly public or collaborators-only;
-- its identity, audience and order never change (key epochs may advance).
CREATE TRIGGER comment_thread_public_epoch_audience BEFORE INSERT ON comment_threads
WHEN NEW.purpose = 'public'
BEGIN
  SELECT RAISE(ABORT, 'public comment thread requires an audience epoch')
  WHERE NOT EXISTS (SELECT 1 FROM comment_thread_epochs e WHERE e.id = NEW.current_epoch_id
    AND e.thread_id = NEW.id AND e.audience IN ('public', 'collaborators_only'));
END;
--> statement-breakpoint
CREATE TRIGGER comment_thread_private_epoch_audience BEFORE INSERT ON comment_threads
WHEN NEW.purpose = 'private'
BEGIN
  SELECT RAISE(ABORT, 'private comment thread requires an audience-free epoch')
  WHERE EXISTS (SELECT 1 FROM comment_thread_epochs e WHERE e.id = NEW.current_epoch_id
    AND e.thread_id = NEW.id AND e.audience IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER comment_thread_epoch_identity_immutable BEFORE UPDATE OF id, thread_id, audience, ordinal ON comment_thread_epochs
WHEN NEW.id != OLD.id OR NEW.thread_id != OLD.thread_id OR NEW.audience IS NOT OLD.audience OR NEW.ordinal != OLD.ordinal
BEGIN SELECT RAISE(ABORT, 'comment epoch immutable'); END;
--> statement-breakpoint
-- A link wrapper exists only for a public epoch and names only that epoch's own
-- Publication link and current capability epoch.
CREATE TRIGGER public_comment_epoch_link_guard BEFORE INSERT ON public_comment_epoch_links
BEGIN
  SELECT RAISE(ABORT, 'invalid public comment link wrapper')
  WHERE NOT EXISTS (SELECT 1 FROM comment_thread_epochs e JOIN comment_threads t ON t.id = e.thread_id
    JOIN publication_links l ON l.id = NEW.link_id AND l.publication_id = t.publication_id
    WHERE e.id = NEW.epoch_id AND e.audience = 'public' AND e.key_epoch = NEW.key_epoch
      AND t.purpose = 'public' AND t.publication_id = NEW.publication_id);
END;
--> statement-breakpoint
CREATE TRIGGER public_comment_epoch_link_update BEFORE UPDATE OF epoch_id, publication_id, link_id, key_epoch ON public_comment_epoch_links
BEGIN
  SELECT RAISE(ABORT, 'invalid public comment link wrapper')
  WHERE NOT EXISTS (SELECT 1 FROM comment_thread_epochs e JOIN comment_threads t ON t.id = e.thread_id
    JOIN publication_links l ON l.id = NEW.link_id AND l.publication_id = t.publication_id
    WHERE e.id = NEW.epoch_id AND e.audience = 'public' AND e.key_epoch = NEW.key_epoch
      AND t.purpose = 'public' AND t.publication_id = NEW.publication_id);
END;
