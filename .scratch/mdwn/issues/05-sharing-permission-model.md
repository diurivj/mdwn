# Sharing & permission model

Type: grilling
Status: open
Blocked by: 01

## Question

Design the account-to-account sharing mechanism (distinct from public publish links):

- A share grants an account access to a **directory**. Is it read-only or read/write? (Working assumption: read/write, since a shared diet plan is edited by both.)
- Is sharing **recursive** to the whole subtree, and does it include files added later?
- Can a share be per-file as well as per-directory?
- Who owns content created inside a shared directory? What happens on move/rename out of a shared subtree?
- Can a collaborator re-share? Can the owner revoke, and what happens to content at revoke time?
- Write the canonical domain terms (owner, collaborator, share, grant) into `CONTEXT.md`.

## Answer
