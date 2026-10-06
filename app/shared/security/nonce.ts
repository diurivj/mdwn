import { createContext } from "react-router";

/**
 * Per-request CSP nonce, generated in workers/app.ts and handed to the load
 * context (a RouterContextProvider). entry.server.tsx reads it to stamp the
 * document's inline scripts; workers/app.ts reads the same value back to set
 * the CSP header, so the header nonce always matches the script nonces.
 */
export const cspNonceContext = createContext<string | undefined>(undefined);