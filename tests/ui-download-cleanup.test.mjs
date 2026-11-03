import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('const activeDownloadUrls = new Set();');
const end = html.indexOf('/* UI: encrypt / decrypt */', start);
assert.ok(start >= 0 && end > start);
const script = html.slice(start, end);

function harness({ clickThrows = false } = {}) {
  const created = [], revoked = [], clicked = [], timers = [];
  const context = vm.createContext({
    Set, URL: { createObjectURL(blob) { created.push(blob); return 'blob:test-' + created.length; },
      revokeObjectURL(url) { revoked.push(url); } },
    document: { createElement(name) { assert.equal(name, 'a'); return {
      click() { if (clickThrows) throw new Error('download blocked'); clicked.push([this.href, this.download]); }
    }; } },
    setTimeout(callback) { timers.push(callback); }
  });
  vm.runInContext(script, context);
  return { context, created, revoked, clicked, timers };
}

test('successful download keeps object URL briefly then revokes it', () => {
  const ui = harness();
  ui.context.download(new Blob(['authenticated data']), 'recovered.txt');
  assert.deepEqual(ui.clicked, [['blob:test-1', 'recovered.txt']]);
  assert.deepEqual(ui.revoked, []);
  assert.equal(ui.timers.length, 1);
  ui.timers[0]();
  assert.deepEqual(ui.revoked, ['blob:test-1']);
  ui.context.releaseDownloadUrls();
  assert.deepEqual(ui.revoked, ['blob:test-1'], 'cleanup is idempotent');
});

test('click failure revokes URL immediately and page exit revokes outstanding URLs', () => {
  const failed = harness({ clickThrows: true });
  assert.throws(() => failed.context.download(new Blob(['data']), 'x'), /download blocked/);
  assert.deepEqual(failed.revoked, ['blob:test-1']);
  assert.equal(failed.timers.length, 0);
  const active = harness();
  active.context.download(new Blob(['one']), 'one');
  active.context.download(new Blob(['two']), 'two');
  active.context.releaseDownloadUrls();
  assert.deepEqual(active.revoked, ['blob:test-1', 'blob:test-2']);
  for (const timer of active.timers) timer();
  assert.deepEqual(active.revoked, ['blob:test-1', 'blob:test-2']);
  assert.match(html, /vaultUi\?\.dispose\(\);\s*releaseDownloadUrls\(\);/);
});
