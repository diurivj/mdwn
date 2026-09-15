# Public publish model

Type: grilling
Status: open
Blocked by: 01, 05

## Question

Design per-file **public publish** (the second, separate sharing mechanism):

- What does a published file's URL look like — random unguessable slug, readable slug from the title, or both?
- Is publishing per-file only, or can a directory be published? (Assumption: per-file only for MVP; directory publishing is a later sibling of this question.)
- Revocation: does unpublishing break the link immediately, and what does a visitor see?
- Anonymous access: what exactly is rendered, is it indexable by search engines, and does it carry identifying metadata?
- Interaction with the privacy model (`01`): if content is end-to-end encrypted, how does an anonymous reader's browser get the key? (The obvious answer is a URL fragment; confirm it.)
- Are comments allowed on published files? (Comments are MVP; see `07`.)

## Answer
