import test from 'node:test';
import assert from 'node:assert/strict';
import { V3DeviceStore, V3_DEVICE_DB_NAME } from '../vault-device-store.mjs';
import { encryptV3, decryptV3Normal, decryptV3Recovery, rewrapV3, parseV3 } from '../vault-v3.mjs';

// Isolated IndexedDB double. Each instance represents a different origin/profile.
// Read/write transactions are serialized; writes become visible only on commit.
function databaseDouble() {
  const records = new Map(), openedNames = [];
  let previous = Promise.resolve(), schemaCreated = false, failNextWrite = false;
  return {
    records, openedNames,
    abortNextWrite() { failNextWrite = true; },
    open(name, version) {
      openedNames.push(name);
      assert.equal(version, 1);
      const request = {};
      queueMicrotask(() => {
        const database = {
          objectStoreNames: { contains: value => schemaCreated && value === 'device' },
          createObjectStore(name, options) {
            assert.equal(name, 'device');
            assert.deepEqual(options, { keyPath: 'slot' });
            schemaCreated = true;
          },
          close() {},
          transaction(name, mode) {
            assert.equal(name, 'device');
            const jobs = [];
            const transaction = {
              error: null, abort() { transaction.aborted = true; },
              objectStore() {
                const enqueue = (kind, value) => {
                  const request = {};
                  jobs.push({ kind, value, request });
                  return request;
                };
                return { get: value => enqueue('get', value),
                  add: value => enqueue('add', value), put: value => enqueue('put', value) };
              }
            };
            const execute = async () => {
              const staged = new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
              for (let index = 0; index < jobs.length && !transaction.aborted; index++) {
                const { kind, value, request } = jobs[index];
                if (kind === 'get') request.result = staged.has(value) ? structuredClone(staged.get(value)) : undefined;
                if (kind === 'add' || kind === 'put') staged.set(value.slot, structuredClone(value));
                request.onsuccess?.({ target: request });
                await Promise.resolve();
              }
              if (failNextWrite && mode === 'readwrite') {
                failNextWrite = false;
                transaction.error = new Error('simulated IndexedDB commit failure');
                transaction.aborted = true;
              }
              if (transaction.aborted) transaction.onabort?.();
              else {
                if (mode === 'readwrite') {
                  records.clear();
                  for (const entry of staged) records.set(...entry);
                }
                transaction.oncomplete?.();
              }
            };
            const next = previous.then(execute);
            previous = next.catch(() => {});
            return transaction;
          }
        };
        request.result = database;
        if (!schemaCreated) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

const store = factory => new V3DeviceStore({ indexedDBFactory: factory });
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const asFile = blob => new File([blob], 'vault.gcry');
const source = new TextEncoder().encode('M7.5 profile and recovery integration');
const originalPassphrase = 'integration-original-passphrase';
const reboundPassphrase = 'integration-rebound-passphrase';

async function rejectsWithoutPlaintext(operation, pattern) {
  let result;
  await assert.rejects(async () => { result = await operation(); }, pattern);
  assert.equal(result, undefined);
}

test('persistent provider: encrypt, same-profile unlock, new-profile denial, recovery and rebind', async () => {
  const profileA = databaseDouble(), profileB = databaseDouble();
  const firstDevice = await store(profileA).createDevice();
  const encrypted = await encryptV3(new File([source], 'notes.txt'), originalPassphrase, firstDevice);
  const originalFile = asFile(encrypted.blob);
  const originalBytes = await bytes(encrypted.blob);
  const originalParsed = parseV3(originalBytes);
  assert.equal(originalParsed.name, 'notes.txt');
  assert.equal(profileA.records.get('primary').counter, '1');

  const reopenedA = await store(profileA).openDevice();
  const normal = await decryptV3Normal(originalFile, originalPassphrase, reopenedA);
  assert.deepEqual(await bytes(normal.blob), source);
  assert.equal(normal.name, 'notes.txt');
  await rejectsWithoutPlaintext(() => decryptV3Normal(originalFile, 'wrong passphrase', reopenedA), /authentication failed/);

  await assert.rejects(store(profileB).openDevice(), /missing/);
  const newDevice = await store(profileB).createDevice();
  await rejectsWithoutPlaintext(() => decryptV3Normal(originalFile, originalPassphrase, newDevice),
    /original browser-profile key/);
  assert.deepEqual(await bytes((await decryptV3Recovery(originalFile, encrypted.recoveryCode)).blob), source);
  await rejectsWithoutPlaintext(() => decryptV3Recovery(originalFile, '0'.repeat(72)), /checksum/);

  const rebound = await rewrapV3(originalFile, { recoveryCode: encrypted.recoveryCode },
    reboundPassphrase, newDevice);
  const reboundBytes = await bytes(rebound.blob);
  const reboundParsed = parseV3(reboundBytes);
  assert.deepEqual(reboundParsed.core, originalParsed.core);
  assert.deepEqual(reboundParsed.recoveryMeta, originalParsed.recoveryMeta);
  assert.deepEqual(reboundParsed.recoveryEnvelope, originalParsed.recoveryEnvelope);
  assert.deepEqual(reboundParsed.dataCiphertext, originalParsed.dataCiphertext);
  assert.deepEqual(await bytes(encrypted.blob), originalBytes, 'rewrapping must not mutate the source file');
  assert.equal(profileB.records.get('primary').counter, '1');
  assert.deepEqual(await bytes((await decryptV3Normal(asFile(rebound.blob), reboundPassphrase,
    await store(profileB).openDevice())).blob), source);
  assert.deepEqual(await bytes((await decryptV3Recovery(asFile(rebound.blob), encrypted.recoveryCode)).blob), source);
  await rejectsWithoutPlaintext(() => decryptV3Normal(asFile(rebound.blob), originalPassphrase, reopenedA),
    /original browser-profile key/);
  encrypted.recoveryKey.fill(0);
  assert.ok([...profileA.openedNames, ...profileB.openedNames].every(name => name === V3_DEVICE_DB_NAME));
});

test('concurrent file encryptions reserve distinct persisted device nonces', async () => {
  const profile = databaseDouble();
  const primary = await store(profile).createDevice();
  const reopened = await store(profile).openDevice();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    encryptV3(new File([new Uint8Array([index])], `file-${index}.bin`), originalPassphrase,
      index % 2 ? primary : reopened)));
  const parsed = await Promise.all(results.map(async result => parseV3(await bytes(result.blob))));
  const nonces = parsed.map(item => Buffer.from(item.deviceNonce).toString('hex'));
  assert.equal(new Set(nonces).size, 12);
  assert.equal(profile.records.get('primary').counter, '12');
  for (let index = 0; index < results.length; index++) {
    const opened = await decryptV3Normal(asFile(results[index].blob), originalPassphrase,
      await store(profile).openDevice());
    assert.deepEqual(await bytes(opened.blob), new Uint8Array([index]));
    results[index].recoveryKey.fill(0);
  }
});

test('aborted nonce transaction fails encryption and rebind without returning output', async () => {
  const profile = databaseDouble();
  const device = await store(profile).createDevice();
  profile.abortNextWrite();
  await rejectsWithoutPlaintext(() => encryptV3(new File([source], 'notes.txt'), originalPassphrase, device),
    /simulated IndexedDB commit failure/);
  assert.equal(profile.records.get('primary').counter, '0');

  const encrypted = await encryptV3(new File([source], 'notes.txt'), originalPassphrase, device);
  assert.equal(profile.records.get('primary').counter, '1');
  const target = databaseDouble();
  const newDevice = await store(target).createDevice();
  target.abortNextWrite();
  await rejectsWithoutPlaintext(() => rewrapV3(asFile(encrypted.blob),
    { recoveryCode: encrypted.recoveryCode }, reboundPassphrase, newDevice),
  /simulated IndexedDB commit failure/);
  assert.equal(target.records.get('primary').counter, '0');
  encrypted.recoveryKey.fill(0);
});

test('missing, corrupt and exhausted device state fails closed for V3 operations', async () => {
  const profile = databaseDouble();
  const device = await store(profile).createDevice();
  const encrypted = await encryptV3(new File([source], 'notes.txt'), originalPassphrase, device);
  const file = asFile(encrypted.blob);
  profile.records.delete('primary');
  await assert.rejects(store(profile).openDevice(), /missing/);
  await rejectsWithoutPlaintext(() => encryptV3(new File([source], 'other.txt'), originalPassphrase, device), /missing/);
  profile.records.set('primary', { slot: 'primary', version: 1, key: device.key,
    id: device.id.slice(), noncePrefix: new Uint8Array(4), counter: 'invalid' });
  await assert.rejects(store(profile).openDevice(), /corrupt/);
  await rejectsWithoutPlaintext(() => encryptV3(new File([source], 'other.txt'), originalPassphrase, device), /corrupt/);
  profile.records.get('primary').counter = ((1n << 64n) - 1n).toString();
  await rejectsWithoutPlaintext(() => rewrapV3(file, { recoveryCode: encrypted.recoveryCode },
    reboundPassphrase, device), /exhausted/);
  assert.deepEqual(await bytes((await decryptV3Recovery(file, encrypted.recoveryCode)).blob), source);
  encrypted.recoveryKey.fill(0);
});
