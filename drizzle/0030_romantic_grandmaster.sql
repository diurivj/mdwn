-- Ticket 68: the Owner link copy. The active link's read capability sealed
-- under the Owner's own Vault root key (a `vault-recovery` envelope bound to
-- this path and Publication), so the Owner's devices can show the complete
-- link again. The service cannot open it. It is replaced with the link on
-- rotation and removed with the link row when Unpublishing seals the
-- Publication or the File is deleted. NULL for a link created without one.
-- The column CHECK is written here because Drizzle can add a table CHECK only
-- by rebuilding the table, which would drop its rotation and seal triggers.
ALTER TABLE `publication_links` ADD `owner_link_envelope` blob
  CONSTRAINT "publication_links_owner_link_bounded" CHECK ("owner_link_envelope" IS NULL
    OR (typeof("owner_link_envelope") = 'blob' AND length("owner_link_envelope") BETWEEN 1 AND 1024));
