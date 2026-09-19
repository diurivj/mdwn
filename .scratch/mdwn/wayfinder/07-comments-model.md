# Comments model

Type: grilling
Status: resolved
Assignee: diurivj
Blocked by: 05, 13

## Question

Comments are **in the MVP**. Design them:

- Where can comments attach — file-level, line/inline, or directory-level? (Assumption: file-level only for MVP.)
- Who can comment: collaborators on a shared directory, anonymous readers of a public link, or only logged-in accounts?
- Threading and resolution: flat list, replies, resolve/archive?
- Notifications: none for MVP? (If so, park in Not yet specified rather than deciding.)
- How do comments interact with the privacy model and with end-to-end encryption, if chosen in `01`?

## Answer

**Resolution — Browser-encrypted flat file comment threads.**

### Scope, audiences, and format

- A **Comment** attaches only to a stable File identity and follows that File through rename and move. The MVP has no directory, line, selection, or inline Comments.
- Each File has a separate **Private comment thread** and, when it has an active Publication, a separate **Public comment thread**. Comments never cross between those audiences.
- The Private comment thread is readable and writable by the Owner and every active Collaborator with current File-read access, including a read-only directory or direct File Grant. Any active Grant that provides File-read access supplies identical Private Comment participation; its strongest effective permission changes Markdown and structural authority, not Comment authority. The Public comment thread follows [Define Collaborators-only Public Comment capabilities](21-define-collaborators-only-public-comment-capabilities.md): public readers with the complete Public link may read only public audience epochs, signed-in Accounts may post in that mode, and Collaborators-only epochs permit only the Owner and Accounts with current File-read access to read or post.
- Every Comment displays its author’s Public pseudonym. The existing pseudonym-change policy applies wherever that attribution is shown.
- A thread is a flat list: no replies, thread resolution, archive state, reactions, attachments, mentions, embeds, or rich Markdown. Comment bodies are plain text with line breaks, capped at 2,000 characters; raw HTML and Markdown are not interpreted.

### Authority and lifecycle

- While they retain current File-read access, an author may edit or hard-delete their own Comment. A File Owner may hard-delete any Comment in either thread, but cannot edit another author’s text. There is no edit history, restore action, or separate moderator role in the MVP.
- Private-thread access and Comment-mutation authority follow current File-read access. A newly granted Collaborator can read current history; revocation ends future server-mediated access and advances the relevant encryption epoch, without recalling plaintext or keys already downloaded. Revoking one overlapping Grant leaves that access unchanged when another active Grant still permits the File.
- Public-link rotation preserves the active Public Comment thread and rewraps only its public epochs for the new Public-link capability. Audience changes begin fresh epochs and never make Collaborators-only Comments public. Unpublishing irreversibly seals and hard-deletes every Public-thread record after an explicit confirmation; a later new Publication starts with a fresh Public Comment thread. Deleting the File hard-deletes both threads.

### Privacy boundary

- Comment text and the displayed pseudonym are encrypted and decrypted only in the browser. A distinct **Comment thread capability** protects each thread: Private-thread capability material is enveloped to every currently authorized Account/device with File-read access, independent of Grant permission. A logical Public thread has independent audience-epoch capabilities, with public epochs wrapped to the Publication capability and eligible Owner/Collaborator devices directly enveloped for retained history; Collaborators-only epochs have no Public-link wrapper.
- Rotation rewraps public audience epochs for the new Publication capability so the discussion persists. The service never receives a fragment or plaintext capability; the detailed envelope, revocation, endpoint, and teardown rules are in [Define Collaborators-only Public Comment capabilities](21-define-collaborators-only-public-comment-capabilities.md).
- The service stores ciphertext plus opaque record and account references, authorization records, ciphertext sizes, and server timestamps needed to route, authorize, and rate-limit requests. It cannot read Comment text or displayed pseudonyms, and it provides no server-side comment search or text moderation.

Comment notifications are outside the MVP. Detailed public-internet abuse and rate-limit policy is deliberately continued by [Lock abuse and rate-limit policy](16-lock-abuse-and-rate-limit-policy.md), informed by [Research: privacy-preserving abuse controls on Cloudflare](15-research-privacy-preserving-abuse-controls-on-cloudflare.md).
