# Owner-controlled sharing boundaries

mdwn will support both recursive directory Shares and independent individual-file Shares, but only an object’s Owner may create or change them. Directory Shares include future descendants, while file Shares follow the file identity without exposing surrounding paths; Collaborators cannot reshare or move content across owner boundaries. This deliberately favors a small, comprehensible permission and capability graph over delegated sharing and ambiguous ownership transfer in the MVP.

## Consequences

Directory read/write Grants cover content and structure within the shared subtree, while file read/write Grants cover Markdown editing only. Overlapping Grants are independent and unioned by effective permission, so revoking one Grant cannot remove access supplied by another. Revocation rotates the relevant key epoch for future access but cannot recall plaintext or keys already downloaded. Pending invitations require recipient acceptance, and content created in a shared directory—including a Collaborator’s confirmed browser import—remains owned by that Directory’s Owner.