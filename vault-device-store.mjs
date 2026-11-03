// IndexedDB is scoped to the current origin. This store never opens study storage.
export const V3_DEVICE_DB_NAME = 'gestcrypt-v3-vault';
export const V3_DEVICE_DB_VERSION = 1;
const STORE = 'device';
const SLOT = 'primary';
const MAX_COUNTER = (1n << 64n) - 1n;
const byteEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function validRecord(record) {
  const key = record?.key;
  return record?.slot === SLOT && record.version === 1 &&
    record.id instanceof Uint8Array && record.id.length === 16 &&
    record.noncePrefix instanceof Uint8Array && record.noncePrefix.length === 4 &&
    typeof record.counter === 'string' && /^(0|[1-9][0-9]*)$/.test(record.counter) &&
    BigInt(record.counter) <= MAX_COUNTER &&
    key?.type === 'secret' && key.algorithm?.name === 'AES-GCM' &&
    key.algorithm.length === 256 && key.extractable === false &&
    Array.isArray(key.usages) && key.usages.includes('encrypt') && key.usages.includes('decrypt');
}

function randomBytes(length, random) {
  const value = random(length);
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error('Vault secure randomness is unavailable.');
  return value.slice();
}

export class V3DeviceStore {
  constructor({ indexedDBFactory = globalThis.indexedDB,
    subtle = globalThis.crypto?.subtle,
    random = length => globalThis.crypto.getRandomValues(new Uint8Array(length)) } = {}) {
    this.indexedDBFactory = indexedDBFactory;
    this.subtle = subtle;
    this.random = random;
  }

  async #database() {
    if (!this.indexedDBFactory || !this.subtle) throw new Error('Vault IndexedDB or Web Crypto is unavailable.');
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      try { request = this.indexedDBFactory.open(V3_DEVICE_DB_NAME, V3_DEVICE_DB_VERSION); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'slot' });
      };
      request.onsuccess = () => {
        if (settled) request.result.close();
        else { settled = true; resolve(request.result); }
      };
      request.onerror = () => { if (!settled) { settled = true; reject(request.error || new Error('Vault database open failed.')); } };
      request.onblocked = () => { if (!settled) { settled = true; reject(new Error('Vault database upgrade is blocked.')); } };
    });
  }

  async #transaction(mode, operation) {
    const db = await this.#database();
    return new Promise((resolve, reject) => {
      let tx, value, failure;
      try { tx = db.transaction(STORE, mode); }
      catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = () => { db.close(); reject(failure || tx.error || new Error('Vault transaction aborted.')); };
      tx.onerror = () => { /* onabort reports the transaction failure */ };
      const finish = result => { value = result; };
      const abort = error => {
        failure = error;
        try { tx.abort(); } catch { db.close(); reject(error); }
      };
      try { operation(tx.objectStore(STORE), finish, abort); }
      catch (error) { abort(error); }
    });
  }

  async #record() {
    const record = await this.#transaction('readonly', (store, finish) => {
      store.get(SLOT).onsuccess = event => finish(event.target.result);
    });
    if (record === undefined) throw new Error('Vault device key is missing.');
    if (!validRecord(record)) throw new Error('Vault device-key record is corrupt or incompatible.');
    return record;
  }

  #provider(record) {
    const stableId = record.id.slice();
    return Object.freeze({ key: record.key, id: stableId.slice(),
      reserveNonce: () => this.reserveNonce(stableId) });
  }

  async openDevice() { return this.#provider(await this.#record()); }

  async createDevice() {
    // Generate before the transaction; no asynchronous work may suspend its read/write phase.
    if (!this.subtle) throw new Error('Web Crypto is unavailable.');
    const key = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const record = { slot: SLOT, version: 1, key, id: randomBytes(16, this.random),
      noncePrefix: randomBytes(4, this.random), counter: '0' };
    await this.#transaction('readwrite', (store, finish, abort) => {
      store.get(SLOT).onsuccess = event => {
        if (event.target.result !== undefined) { abort(new Error('Vault device key already exists; it was not replaced.')); return; }
        store.add(record);
        finish(record);
      };
    });
    return this.#provider(record);
  }

  async reserveNonce(expectedId) {
    if (!(expectedId instanceof Uint8Array) || expectedId.length !== 16) throw new Error('Invalid Vault device-key ID.');
    return this.#transaction('readwrite', (store, finish, abort) => {
      store.get(SLOT).onsuccess = event => {
        const record = event.target.result;
        if (record === undefined) { abort(new Error('Vault device key is missing.')); return; }
        if (!validRecord(record)) { abort(new Error('Vault device-key record is corrupt or incompatible.')); return; }
        if (!byteEqual(record.id, expectedId)) { abort(new Error('Vault device key changed; nonce reservation refused.')); return; }
        const next = BigInt(record.counter) + 1n;
        if (next > MAX_COUNTER) { abort(new Error('Vault device nonce counter is exhausted.')); return; }
        const nonce = new Uint8Array(12);
        nonce.set(record.noncePrefix);
        let value = next;
        for (let i = 11; i >= 4; i--) { nonce[i] = Number(value & 255n); value >>= 8n; }
        store.put({ ...record, counter: next.toString() });
        finish(nonce);
      };
    }); // Resolves only after the read/write transaction commits.
  }
}
