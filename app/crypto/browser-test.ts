import {
  createNonceAllocator,
  decodeEnvelope,
  importHpkePrivateKey,
  IndexedDbNonceCounterStore,
  IndexedDbReplayGuard,
  openAesGcm,
  openHpke,
  sealAesGcm,
  sealHpke,
} from "./index";
import {
  ENC_V1_VECTOR_CONTEXT,
  ENC_V1_VECTOR_CIPHERTEXT_HEX,
  ENC_V1_VECTOR_KEY,
  ENC_V1_VECTOR_NONCE,
  ENC_V1_VECTOR_PLAINTEXT,
  HPKE_VECTOR_EPHEMERAL_KEY_MATERIAL,
  HPKE_VECTOR_ENVELOPE_HEX,
  HPKE_VECTOR_PRIVATE_KEY,
  HPKE_VECTOR_PUBLIC_KEY,
} from "./test-vector";

export interface BrowserVectorResult {
  aesCiphertext: string;
  aesVectorMatches: boolean;
  hpkeOpened: boolean;
  hpkeVectorMatches: boolean;
  hpkePrivateExtractable: boolean;
  nonceUnique: boolean;
  replayRejected: boolean;
}

export async function runBrowserVector(
  progress: (stage: string) => void = () => undefined,
  databaseName = "mdwn-enc-v1-browser-test",
): Promise<BrowserVectorResult> {
  const attempt = async <T,>(label: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw new Error(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  progress("AES seal");
  const aesEnvelope = await attempt("AES seal", () =>
    sealAesGcm({
      context: ENC_V1_VECTOR_CONTEXT,
      key: ENC_V1_VECTOR_KEY,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      nonce: ENC_V1_VECTOR_NONCE,
    }),
  );
  const aesDecoded = decodeEnvelope(aesEnvelope);
  progress("AES open");
  const replayGuard = new IndexedDbReplayGuard(databaseName);
  await attempt("AES open", () =>
    openAesGcm({
      envelope: aesEnvelope,
      key: ENC_V1_VECTOR_KEY,
      expectedContext: ENC_V1_VECTOR_CONTEXT,
      replayGuard,
    }),
  );
  let replayRejected = false;
  progress("AES replay");
  try {
    await openAesGcm({
      envelope: aesEnvelope,
      key: ENC_V1_VECTOR_KEY,
      expectedContext: ENC_V1_VECTOR_CONTEXT,
      replayGuard,
    });
  } catch {
    replayRejected = true;
  }

  progress("HPKE import");
  const recipientPrivateKey = await attempt("HPKE import", () =>
    importHpkePrivateKey(HPKE_VECTOR_PRIVATE_KEY),
  );
  progress("HPKE seal");
  const hpkeEnvelope = await attempt("HPKE seal", () =>
    sealHpke({
      context: ENC_V1_VECTOR_CONTEXT,
      plaintext: ENC_V1_VECTOR_PLAINTEXT,
      recipientPublicKey: HPKE_VECTOR_PUBLIC_KEY,
      ephemeralKeyMaterial: HPKE_VECTOR_EPHEMERAL_KEY_MATERIAL,
    }),
  );
  progress("HPKE open");
  const hpkePlaintext = await attempt("HPKE open", () =>
    openHpke({
      envelope: hpkeEnvelope,
      recipientPrivateKey,
      recipientPublicKey: HPKE_VECTOR_PUBLIC_KEY,
      expectedContext: ENC_V1_VECTOR_CONTEXT,
    }),
  );

  progress("nonce allocation");
  const nonceStore = new IndexedDbNonceCounterStore(databaseName);
  const nonceAllocatorA = createNonceAllocator({
    namespace: Uint8Array.from([0, 1, 2, 3, 4, 5]),
    store: nonceStore,
  });
  const nonceAllocatorB = createNonceAllocator({
    namespace: Uint8Array.from([0, 1, 2, 3, 4, 5]),
    store: nonceStore,
  });
  const nonces = await attempt("IndexedDB nonce allocation", () =>
    Promise.all([
      nonceAllocatorA.allocate("browser-test-key"),
      nonceAllocatorB.allocate("browser-test-key"),
    ]),
  );

  return {
    aesCiphertext: hex(aesDecoded.ciphertext),
    aesVectorMatches: hex(aesDecoded.ciphertext) === ENC_V1_VECTOR_CIPHERTEXT_HEX,
    hpkeOpened: hex(hpkePlaintext) === hex(ENC_V1_VECTOR_PLAINTEXT),
    hpkeVectorMatches: hex(hpkeEnvelope) === HPKE_VECTOR_ENVELOPE_HEX,
    hpkePrivateExtractable: recipientPrivateKey.extractable,
    nonceUnique: new Set(nonces.map(hex)).size === nonces.length,
    replayRejected,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
