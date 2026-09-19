# End-to-end content privacy

mdwn will end-to-end encrypt private Markdown content: browsers encrypt and decrypt it, while the application service and database store only opaque ciphertext. This deliberately trades away simple server-side rendering and server-side search in order to make the stated private-vault promise meaningful even on inexpensive managed infrastructure.

## Consequences

Public viewing must use an explicit client-side capability mechanism, and sharing, comments, import/export, and the schema must all be designed around client-held content keys. mdwn will have no passwords, tracking, analytics, advertising, or behavioural profiling; narrowly scoped operational security and abuse logs are allowed only when they exclude content, decryption keys, and public-link fragments and have bounded retention. Browser-side export and hard deletion are privacy requirements.
