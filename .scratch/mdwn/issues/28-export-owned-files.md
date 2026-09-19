# 28: Export owned Files with Archive manifest and Private-Comment sidecar

**What to build:** A person exports everything they own as a zip they can hold themselves — exact Markdown source, mirrored folders, historical Private Comments — created entirely in the browser and excluding anything they merely have access to through a Share.

**Blocked by:** 15 (Editor and preview workspace), 21 (Private Comment threads).

**Status:** ready-for-agent

- [ ] **Export my Files** includes every File owned by the current Account; a selected owned File or owned Directory can also be exported from the Files chrome.
- [ ] Shared-only content is never included, even as a static copy.
- [ ] The browser decrypts locally and creates one ZIP without sending plaintext to the service.
- [ ] The Directory hierarchy is mirrored with UTF-8 `.md` files containing exact Markdown source; YAML front matter remains uninterpreted source.
- [ ] `.mdwn/manifest.json` is versioned and identifies roots and format without carrying live authority.
- [ ] `.mdwn/private-comments.json` preserves historical Private Comment text, order, timestamp, and displayed Public pseudonym for exported owned Files.
- [ ] Public Comments and all Publication state are omitted, as are Shares, Grants, capabilities and keys, credentials and recovery material, sessions, service IDs, and local drafts.
- [ ] Export is available to the Owner and is never blocked by Public-participation limits; it cannot recall material already downloaded by other clients, and the UI does not claim it can.
- [ ] Tests assert the ownership boundary (shared-only content excluded), that no plaintext reaches the service during export, and that the produced archive passes Import preflight (ticket 29).
