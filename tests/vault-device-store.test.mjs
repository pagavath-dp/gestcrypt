import test from 'node:test';
import assert from 'node:assert/strict';
import { V3DeviceStore, V3_DEVICE_DB_NAME } from '../vault-device-store.mjs';
import { encryptV3 } from '../vault-v3.mjs';

// Minimal transactional IndexedDB double: commits are serialized, and a failed commit
// rolls back all writes. No browser storage or study storage is touched by these tests.
function databaseDouble() {
  const records = new Map(), names = [];
  let tail = Promise.resolve(), failCommit = false, schemaCreated = false;
  const factory = {
    records, names,
    failNextCommit() { failCommit = true; },
    open(name, version) {
      names.push(name);
      assert.equal(version, 1);
      const request = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: value => value === 'device' && schemaCreated },
          createObjectStore(value, options) {
            assert.equal(value, 'device');
            assert.deepEqual(options, { keyPath: 'slot' });
            schemaCreated = true;
          },
          close() {},
          transaction(storeName, mode) {
            assert.equal(storeName, 'device');
            const tx = { error: null, abort() { tx.aborted = true; }, objectStore() {
              const issue = (kind, value) => {
                const req = {};
                tasks.push({ kind, value, req });
                return req;
              };
              return { get: key => issue('get', key), add: value => issue('add', value),
                put: value => issue('put', value) };
            } };
            const tasks = [];
            const run = async () => {
              const staged = new Map([...records].map(([key, value]) => [key, structuredClone(value)]));
              let index = 0;
              while (index < tasks.length && !tx.aborted) {
                const { kind, value, req } = tasks[index++];
                if (kind === 'get') req.result = staged.has(value) ? structuredClone(staged.get(value)) : undefined;
                if (kind === 'add') {
                  if (staged.has(value.slot)) { tx.error = new Error('ConstraintError'); tx.aborted = true; }
                  else staged.set(value.slot, structuredClone(value));
                }
                if (kind === 'put') staged.set(value.slot, structuredClone(value));
                if (req.onsuccess && !tx.aborted) req.onsuccess({ target: req });
                await Promise.resolve();
              }
              if (failCommit && mode === 'readwrite') {
                failCommit = false; tx.error = new Error('simulated commit failure'); tx.aborted = true;
              }
              if (tx.aborted) tx.onabort?.();
              else { if (mode === 'readwrite') { records.clear(); for (const entry of staged) records.set(...entry); } tx.oncomplete?.(); }
            };
            const next = tail.then(run);
            tail = next.catch(() => {});
            return tx;
          }
        };
        request.result = db;
        if (!schemaCreated) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
  return factory;
}

const storeFor = indexedDBFactory => new V3DeviceStore({ indexedDBFactory });
const asHex = value => Buffer.from(value).toString('hex');

test('creates one non-extractable device key and restores it through a new connection', async () => {
  const db = databaseDouble();
  const original = await storeFor(db).createDevice();
  const restored = await storeFor(db).openDevice();
  assert.equal(original.key.extractable, false);
  assert.deepEqual(original.key.usages.sort(), ['decrypt', 'encrypt']);
  assert.deepEqual(restored.id, original.id);
  assert.equal(restored.key.extractable, false);
  assert.equal(db.records.get('primary').counter, '0');
  await assert.rejects(storeFor(db).createDevice(), /already exists/);
  assert.deepEqual((await storeFor(db).openDevice()).id, original.id);
  assert.ok(db.names.every(name => name === V3_DEVICE_DB_NAME));
});

test('concurrent creation keeps exactly one device key', async () => {
  const db = databaseDouble();
  const outcomes = await Promise.allSettled([storeFor(db).createDevice(), storeFor(db).createDevice()]);
  assert.deepEqual(outcomes.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  const winner = outcomes.find(item => item.status === 'fulfilled').value;
  assert.deepEqual((await storeFor(db).openDevice()).id, winner.id);
  assert.equal(db.records.size, 1);
});

test('concurrent reservations are unique, ordered and durable across connections', async () => {
  const db = databaseDouble();
  const first = await storeFor(db).createDevice();
  const second = await storeFor(db).openDevice();
  const nonces = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    (i % 2 ? first : second).reserveNonce()));
  assert.equal(new Set(nonces.map(asHex)).size, 40);
  assert.equal(db.records.get('primary').counter, '40');
  assert.equal(asHex(await storeFor(db).openDevice().then(device => device.reserveNonce())).slice(-16),
    '0000000000000029');
});

test('failed encryption still consumes its committed device nonce', async () => {
  const db = databaseDouble();
  const device = await storeFor(db).createDevice();
  await assert.rejects(encryptV3(new File([], 'x'), 'long-test-passphrase', device,
    { random: length => new Uint8Array(length - 1) }), /Secure random bytes/);
  assert.equal(db.records.get('primary').counter, '1');
  assert.equal(asHex(await device.reserveNonce()).slice(-8), '00000002');
});

test('failed transaction neither returns a nonce nor advances counter', async () => {
  const db = databaseDouble();
  const device = await storeFor(db).createDevice();
  db.failNextCommit();
  await assert.rejects(device.reserveNonce(), /simulated commit failure/);
  assert.equal(db.records.get('primary').counter, '0');
  assert.equal(asHex(await device.reserveNonce()).slice(-8), '00000001');
});

test('missing, corrupted, incompatible and exhausted records fail closed', async () => {
  const db = databaseDouble();
  await assert.rejects(storeFor(db).openDevice(), /missing/);
  const original = await storeFor(db).createDevice();
  db.records.get('primary').counter = 'not-a-counter';
  await assert.rejects(storeFor(db).openDevice(), /corrupt/);
  await assert.rejects(original.reserveNonce(), /corrupt/);
  db.records.get('primary').counter = ((1n << 64n) - 1n).toString();
  await assert.rejects(original.reserveNonce(), /exhausted/);
  db.records.get('primary').version = 2;
  await assert.rejects(storeFor(db).openDevice(), /incompatible/);
  await assert.rejects(storeFor(db).createDevice(), /already exists/);
});

test('stale provider and separate origin databases cannot claim another device key', async () => {
  const originA = databaseDouble(), originB = databaseDouble();
  const device = await storeFor(originA).createDevice();
  await assert.rejects(storeFor(originB).openDevice(), /missing/);
  const other = await storeFor(originB).createDevice();
  assert.notDeepEqual(device.id, other.id);
  originA.records.get('primary').id = other.id;
  await assert.rejects(device.reserveNonce(), /device key changed/);
  assert.equal(originA.records.get('primary').counter, '0');
  assert.ok([...originA.names, ...originB.names].every(name => name === V3_DEVICE_DB_NAME));
});

test('caller mutation of the exposed ID cannot redirect nonce reservations', async () => {
  const db = databaseDouble();
  const device = await storeFor(db).createDevice();
  device.id.fill(0);
  assert.equal(asHex(await device.reserveNonce()).slice(-8), '00000001');
});

test('database-open failure prevents device creation and nonce reservation', async () => {
  const db = databaseDouble();
  const device = await storeFor(db).createDevice();
  db.open = () => { throw new Error('storage unavailable'); };
  await assert.rejects(device.reserveNonce(), /storage unavailable/);
  await assert.rejects(storeFor(db).createDevice(), /storage unavailable/);
  assert.equal(db.records.get('primary').counter, '0');
});
