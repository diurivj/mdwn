export type StoredDevice = {
  accountId: string;
  deviceId: string;
  registryEpoch: number;
  transportKeyPair: CryptoKeyPair;
  assertionKeyPair: CryptoKeyPair;
};

const DATABASE = "mdwn-device-store";
const STORE = "devices";
const PENDING_RECOVERY = "pending_recovery";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "accountId" });
      if (!request.result.objectStoreNames.contains(PENDING_RECOVERY)) {
        request.result.createObjectStore(PENDING_RECOVERY, { keyPath: "deviceId" })
          .createIndex("accountId", "accountId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Device store is blocked"));
  });
}

async function readRecords(accountId?: string): Promise<unknown[]> {
  const db = await openDatabase();
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const request = accountId === undefined
        ? transaction.objectStore(STORE).getAll()
        : transaction.objectStore(STORE).get(accountId);
      request.onsuccess = () => resolve(accountId === undefined ? request.result : [request.result]);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

async function writeRecord(device: StoredDevice, add: boolean): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      if (add) transaction.objectStore(STORE).add(device);
      else transaction.objectStore(STORE).put(device);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function isKey(key: unknown, type: KeyType, algorithm: string, usage?: KeyUsage): key is CryptoKey {
  if (!(key instanceof CryptoKey)) return false;
  const info = key.algorithm as EcKeyAlgorithm;
  return key.type === type && key.extractable === (type === "public") &&
    info.name === algorithm && info.namedCurve === "P-256" && (!usage || key.usages.includes(usage));
}

async function validDevice(value: unknown): Promise<boolean> {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Partial<StoredDevice>;
  if (typeof device.accountId !== "string" || !device.accountId ||
      typeof device.deviceId !== "string" || !device.deviceId ||
      !Number.isSafeInteger(device.registryEpoch) || device.registryEpoch! < 0) return false;
  const transport = device.transportKeyPair;
  const assertion = device.assertionKeyPair;
  if (!transport || !assertion ||
      !isKey(transport.privateKey, "private", "ECDH", "deriveBits") ||
      !isKey(transport.publicKey, "public", "ECDH") ||
      !isKey(assertion.privateKey, "private", "ECDSA", "sign") ||
      !isKey(assertion.publicKey, "public", "ECDSA", "verify")) return false;
  try {
    // Deriving against a new independent pair verifies that the two stored ECDH
    // handles correspond; inspecting key metadata alone cannot establish this.
    const probe = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    );
    const [left, right] = await Promise.all([
      crypto.subtle.deriveBits({ name: "ECDH", public: probe.publicKey }, transport.privateKey, 256),
      crypto.subtle.deriveBits({ name: "ECDH", public: transport.publicKey }, probe.privateKey, 256),
    ]);
    if (!new Uint8Array(left).every((byte, index) => byte === new Uint8Array(right)[index])) return false;
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, assertion.privateKey, challenge,
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, assertion.publicKey, signature, challenge,
    );
  } catch {
    return false;
  }
}

function requestPersistence(): void {
  try {
    // Firefox may wait for a permission decision; do not block device creation.
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    // Storage persistence is a browser policy decision, not a prerequisite.
  }
}

export async function createDevice(accountId: string, deviceId: string): Promise<StoredDevice> {
  if (!accountId || !deviceId) throw new Error("Device identifiers are required");
  // Never replace an orphaned or unreadable device record during signup.
  const [transportKeyPair, assertionKeyPair] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  const device: StoredDevice = {
    accountId, deviceId, registryEpoch: 0, transportKeyPair, assertionKeyPair,
  };
  await writeRecord(device, true);
  requestPersistence();
  return device;
}

export async function getDevice(accountId: string): Promise<StoredDevice | null> {
  if (!accountId) return null;
  try {
    const [record] = await readRecords(accountId);
    return await validDevice(record) && (record as StoredDevice).accountId === accountId
      ? record as StoredDevice : null;
  } catch {
    return null;
  }
}

export async function getAnyDevice(): Promise<StoredDevice | null> {
  try {
    for (const record of await readRecords()) {
      if (await validDevice(record)) return record as StoredDevice;
    }
  } catch {
    // Unreadable storage must never bootstrap a device.
  }
  return null;
}

export async function saveDevice(device: StoredDevice): Promise<void> {
  if (!await validDevice(device)) throw new Error("Invalid device keys");
  const existing = await getDevice(device.accountId);
  if (!existing || existing.deviceId !== device.deviceId ||
      device.registryEpoch < existing.registryEpoch) throw new Error("Device keys unavailable");
  for (const kind of ["transportKeyPair", "assertionKeyPair"] as const) {
    const [before, after] = await Promise.all([
      crypto.subtle.exportKey("raw", existing[kind].publicKey),
      crypto.subtle.exportKey("raw", device[kind].publicKey),
    ]);
    if (!new Uint8Array(before).every((byte, index) => byte === new Uint8Array(after)[index])) {
      throw new Error("Device keys cannot be replaced");
    }
  }
  await writeRecord(device, false);
  requestPersistence();
}

export async function updateRegistryEpoch(accountId: string, epoch: number): Promise<void> {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid registry epoch");
  const device = await getDevice(accountId);
  if (!device) throw new Error("Device keys unavailable");
  await saveDevice({ ...device, registryEpoch: epoch });
}

/** Candidate handles are durable but separate from the active-device store until server commit. */
export async function createRecoveryCandidate(accountId: string, deviceId: string): Promise<StoredDevice> {
  if (!accountId || !deviceId) throw new Error("Device identifiers are required");
  const [transportKeyPair, assertionKeyPair] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]),
  ]);
  const device: StoredDevice = { accountId, deviceId, registryEpoch: 0, transportKeyPair, assertionKeyPair };
  if (!await validDevice(device)) throw new Error("Device keys unavailable");
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PENDING_RECOVERY, "readwrite");
      transaction.objectStore(PENDING_RECOVERY).add(device);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
  requestPersistence();
  return device;
}

export async function getRecoveryCandidate(accountId: string, deviceId: string): Promise<StoredDevice | null> {
  try {
    const db = await openDatabase();
    let value: unknown;
    try {
      value = await new Promise((resolve, reject) => {
        const request = db.transaction(PENDING_RECOVERY, "readonly").objectStore(PENDING_RECOVERY).get(deviceId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
    return await validDevice(value) && (value as StoredDevice).accountId === accountId
      ? value as StoredDevice : null;
  } catch { return null; }
}

export async function listRecoveryCandidates(accountId: string): Promise<StoredDevice[]> {
  try {
    const db = await openDatabase();
    let records: unknown[];
    try {
      records = await new Promise((resolve, reject) => {
        const request = db.transaction(PENDING_RECOVERY, "readonly")
          .objectStore(PENDING_RECOVERY).index("accountId").getAll(accountId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
    const devices: StoredDevice[] = [];
    for (const record of records) {
      if (await validDevice(record) && (record as StoredDevice).accountId === accountId) {
        devices.push(record as StoredDevice);
      }
    }
    return devices;
  } catch { return []; }
}

/** Called only after the server reports this exact candidate active at its current epoch. */
export async function activateRecoveryCandidate(accountId: string, deviceId: string, registryEpoch: number): Promise<void> {
  if (!Number.isSafeInteger(registryEpoch) || registryEpoch < 1) throw new Error("Invalid registry epoch");
  const candidate = await getRecoveryCandidate(accountId, deviceId);
  if (!candidate || candidate.deviceId !== deviceId) throw new Error("Device keys unavailable");
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORE, PENDING_RECOVERY], "readwrite");
      transaction.objectStore(STORE).put({ ...candidate, registryEpoch });
      const pending = transaction.objectStore(PENDING_RECOVERY);
      const keys = pending.index("accountId").getAllKeys(accountId);
      keys.onsuccess = () => {
        for (const key of keys.result) pending.delete(key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
  requestPersistence();
}
