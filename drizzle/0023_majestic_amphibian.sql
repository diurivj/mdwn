CREATE TABLE `publication_teardowns` (
	`publication_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`comment_total` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`owner_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "publication_teardowns_comment_total" CHECK("publication_teardowns"."comment_total" >= 0)
);
--> statement-breakpoint
-- A teardown marker exists only for a Publication already sealed for deletion,
-- and its count is the seal's own progress denominator.
CREATE TRIGGER publication_teardown_guard BEFORE INSERT ON publication_teardowns
WHEN NOT EXISTS (SELECT 1 FROM publications p
  WHERE p.id = NEW.publication_id AND p.state = 'deleting' AND p.owner_id = NEW.owner_id)
BEGIN SELECT RAISE(ABORT, 'invalid publication teardown'); END;
--> statement-breakpoint
-- Teardown progress is never rewritten in place; only deletion removes it.
CREATE TRIGGER publication_teardown_immutable BEFORE UPDATE ON publication_teardowns
BEGIN SELECT RAISE(ABORT, 'publication teardown immutable'); END;
--> statement-breakpoint
-- A sealed Publication can never gain a new link or Public representation.
CREATE TRIGGER publication_sealed_link_guard BEFORE INSERT ON publication_links
WHEN NOT EXISTS (SELECT 1 FROM publications p WHERE p.id = NEW.publication_id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'sealed publication'); END;
--> statement-breakpoint
CREATE TRIGGER publication_sealed_representation_guard BEFORE INSERT ON public_representations
WHEN NOT EXISTS (SELECT 1 FROM publications p WHERE p.id = NEW.publication_id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'sealed publication'); END;
--> statement-breakpoint
-- A new Public thread belongs to an active Publication only.
CREATE TRIGGER comment_thread_public_sealed_guard BEFORE INSERT ON comment_threads
WHEN NEW.purpose = 'public' AND NOT EXISTS (SELECT 1 FROM publications p
  WHERE p.id = NEW.publication_id AND p.state = 'active')
BEGIN SELECT RAISE(ABORT, 'sealed publication'); END;
--> statement-breakpoint
-- Rotation (ticket 25) replaces the active link identity in place: the pointer
-- swap must already name the new path, the Publication must still be active,
-- and the retired identifier can never be rewritten back.
DROP TRIGGER publication_link_immutable;
--> statement-breakpoint
CREATE TRIGGER publication_link_rotation_guard BEFORE UPDATE ON publication_links
WHEN NEW.publication_id != OLD.publication_id OR NEW.id = OLD.id
  OR NOT EXISTS (SELECT 1 FROM publications p
    WHERE p.id = NEW.publication_id AND p.state = 'active' AND p.current_link_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'publication link immutable'); END;
