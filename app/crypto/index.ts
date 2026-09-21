import {
  ALGORITHM_SUITE,
  type AlgorithmSuite,
  type EnvelopeContext,
} from "./envelope";
import { type ByteSource } from "./encoding";
import {
  openAesGcm,
  type Aes256Key,
  type OpenAesGcmRequest,
  sealAesGcm,
  type SealAesGcmRequest,
} from "./aes-gcm";
import {
  openHpke,
  type HpkePrivateKey,
  type HpkePublicKey,
  type OpenHpkeRequest,
  sealHpke,
  type SealHpkeRequest,
} from "./hpke";
import type { NonceAllocator, ReplayGuard } from "./nonce";

export * from "./aes-gcm";
export * from "./encoding";
export * from "./envelope";
export * from "./hpke";
export * from "./kdf";
export * from "./nonce";

export type SealEnvelopeRequest =
  | (Omit<SealAesGcmRequest, "context"> & {
      suite: typeof ALGORITHM_SUITE.AES_256_GCM;
      context: EnvelopeContext;
    })
  | (Omit<SealHpkeRequest, "context"> & {
      suite: typeof ALGORITHM_SUITE.HPKE_P256_HKDF_SHA256_AES_256_GCM;
      context: EnvelopeContext;
    });

export async function sealEnvelope(request: SealEnvelopeRequest): Promise<Uint8Array> {
  if (request.suite === ALGORITHM_SUITE.AES_256_GCM) {
    return sealAesGcm(request);
  }
  return sealHpke(request);
}

export type OpenEnvelopeRequest = {
  envelope: ByteSource;
  expectedSuite: AlgorithmSuite;
  expectedContext: EnvelopeContext;
  minimumEpoch?: number;
  replayGuard?: ReplayGuard;
  key?: Aes256Key;
  recipientPrivateKey?: HpkePrivateKey;
  recipientPublicKey?: HpkePublicKey;
};

export async function openEnvelope({
  envelope,
  expectedSuite,
  expectedContext,
  minimumEpoch,
  replayGuard,
  key,
  recipientPrivateKey,
  recipientPublicKey,
}: OpenEnvelopeRequest): Promise<Uint8Array> {
  if (expectedSuite === ALGORITHM_SUITE.AES_256_GCM) {
    if (key === undefined) throw new TypeError("AES-GCM open requires key");
    return openAesGcm({
      envelope,
      key,
      expectedContext,
      minimumEpoch,
      replayGuard,
    } satisfies OpenAesGcmRequest);
  }
  if (recipientPrivateKey === undefined) {
    throw new TypeError("HPKE open requires recipientPrivateKey");
  }
  return openHpke({
    envelope,
    recipientPrivateKey,
    recipientPublicKey,
    expectedContext,
    minimumEpoch,
    replayGuard,
  } satisfies OpenHpkeRequest);
}

export type { NonceAllocator };
