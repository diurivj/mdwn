import { bytesToHex, concatBytes, type ByteSource, toBytes } from "./encoding";

export const NONCE_NAMESPACE_BYTES = 6;
export const NONCE_COUNTER_BYTES = 6;
const MAX_NONCE_COUNTER = (1n << 48n) - 1n;
const DEFAULT_DATABASE_NAME = "mdwn-crypto-v1";
const NONCE_STORE_NAME = "nonce-counters";
const REPLAY_STORE_NAME = "envelope-replays";

export interface NonceCounterStore {
  /** Atomically reserves the next counter for a key/namespace pair. */
  reserve(keyId: string, namespace: Uint8Array): Promise<bigint>;
}

export class NonceAllocationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * In-memory implementation used by unit tests and short-lived callers.
 * Browser production code should use IndexedDbNonceCounterStore.
 */
export class InMemoryNonceCounterStore implements NonceCounterStore {
  private readonly counters = new Map<string, bigint>();

  async reserve(keyId: string, namespace: Uint8Array): Promise<bigint> {
    const storageKey = counterStorageKey(keyId, namespace);
    const current = this.counters.get(storageKey) ?? 0n;
    if (current > MAX_NONCE_COUNTER) {
      throw new NonceAllocationError("nonce counter exhausted; rotate the key");
    }
    this.counters.set(storageKey, current + 1n);
    return current;
  }
}

export interface NonceAllocatorOptions {
  /** A namespace allocated uniquely to this encryption device. */
  namespace: ByteSource;
  store: NonceCounterStore;
}

/**
 * Allocates a 96-bit nonce as `namespace[48 bits] || counter[48 bits]`.
 *
 * The namespace is not generated here: it must be allocated as part of the
 * device registry and never reused for another device. IndexedDB's atomic
 * read/write transaction serializes tabs sharing one browser profile. A
 * counter is committed before encryption, so retries and crashes consume a
 * value rather than reusing it.
 */
export class NonceAllocator {
  private readonly namespace: Uint8Array;
  private readonly store: NonceCounterStore;

  constructor(options: NonceAllocatorOptions) {
    this.namespace = validateNamespace(options.namespace);
    this.store = options.store;
  }

  async allocate(keyId: string): Promise<Uint8Array> {
    if (typeof keyId !== "string" || keyId.length === 0) {
      throw new NonceAllocationError("a key identifier is required for nonce allocation");
    }
    const counter = await this.store.reserve(keyId, this.namespace);
    if (counter < 0n || counter > MAX_NONCE_COUNTER) {
      throw new NonceAllocationError("nonce counter is outside its 48-bit range");
    }
    return concatBytes(this.namespace, counterToBytes(counter));
  }
}

export function createNonceAllocator(options: NonceAllocatorOptions): NonceAllocator {
  return new NonceAllocator(options);
}

export interface ReplayGuard {
  /** Returns true exactly once for a fingerprint, false for a replay. */
  consume(fingerprint: ByteSource): Promise<boolean>;
}

export class InMemoryReplayGuard implements ReplayGuard {
  private readonly consumed = new Set<string>();

  async consume(fingerprint: ByteSource): Promise<boolean> {
    const key = bytesToHex(toBytes(fingerprint));
    if (this.consumed.has(key)) return false;
    this.consumed.add(key);
    return true;
  }
}

export class IndexedDbNonceCounterStore implements NonceCounterStore {
  constructor(private readonly databaseName = DEFAULT_DATABASE_NAME) {}

  async reserve(keyId: string, namespace: Uint8Array): Promise<bigint> {
    const storageKey = counterStorageKey(keyId, namespace);
    const db = await openCryptoDatabase(this.databaseName);
    try {
      return await new Promise<bigint>((resolve, reject) => {
        let allocated: bigint | undefined;
        let failure: unknown;
        const transaction = db.transaction(NONCE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(NONCE_STORE_NAME);
        const request = store.get(storageKey);

        request.onsuccess = () => {
          try {
            const record = request.result as { nextCounter?: string } | undefined;
            const current = record?.nextCounter === undefined ? 0n : BigInt(record.nextCounter);
            if (current > MAX_NONCE_COUNTER) {
              failure = new NonceAllocationError(
                "nonce counter exhausted; rotate the key",
              );
              transaction.abort();
              return;
            }
            allocated = current;
            store.put({ id: storageKey, nextCounter: (current + 1n).toString() });
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };

        transaction.oncomplete = () => {
          if (allocated === undefined) {
            reject(
              failure instanceof Error
                ? failure
                : new NonceAllocationError("nonce allocation did not commit"),
            );
          } else {
            resolve(allocated);
          }
        };
        transaction.onerror = () => {
          reject(failure ?? transaction.error ?? new NonceAllocationError("nonce allocation failed"));
        };
        transaction.onabort = () => {
          reject(failure ?? transaction.error ?? new NonceAllocationError("nonce allocation aborted"));
        };
        request.onerror = () => {
          failure = request.error;
          transaction.abort();
        };
      });
    } finally {
      db.close();
    }
  }
}

export class IndexedDbReplayGuard implements ReplayGuard {
  constructor(private readonly databaseName = DEFAULT_DATABASE_NAME) {}

  async consume(fingerprint: ByteSource): Promise<boolean> {
    const storageKey = bytesToHex(toBytes(fingerprint));
    const db = await openCryptoDatabase(this.databaseName);
    try {
      return await new Promise<boolean>((resolve, reject) => {
        let seen = false;
        const transaction = db.transaction(REPLAY_STORE_NAME, "readwrite");
        const store = transaction.objectStore(REPLAY_STORE_NAME);
        const request = store.get(storageKey);
        request.onsuccess = () => {
          if (request.result !== undefined) {
            seen = true;
          } else {
            store.put({ id: storageKey });
          }
        };
        request.onerror = () => {
          transaction.abort();
          reject(request.error ?? new Error("replay lookup failed"));
        };
        transaction.oncomplete = () => resolve(!seen);
        transaction.onerror = () => reject(transaction.error ?? new Error("replay transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("replay transaction aborted"));
      });
    } finally {
      db.close();
    }
  }
}

function validateNamespace(value: ByteSource): Uint8Array {
  const namespace = toBytes(value);
  if (namespace.byteLength !== NONCE_NAMESPACE_BYTES) {
    throw new NonceAllocationError(
      `nonce namespace must be ${NONCE_NAMESPACE_BYTES} bytes`,
    );
  }
  return namespace;
}

function counterStorageKey(keyId: string, namespace: Uint8Array): string {
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new NonceAllocationError("a key identifier is required for nonce allocation");
  }
  return `${keyId}\u0000${bytesToHex(namespace)}`;
}

function counterToBytes(counter: bigint): Uint8Array {
  const output = new Uint8Array(NONCE_COUNTER_BYTES);
  let remaining = counter;
  for (let index = output.byteLength - 1; index >= 0; index--) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function openCryptoDatabase(databaseName: string): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) {
    return Promise.reject(new Error("IndexedDB is unavailable in this runtime"));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(NONCE_STORE_NAME)) {
        database.createObjectStore(NONCE_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(REPLAY_STORE_NAME)) {
        database.createObjectStore(REPLAY_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}
