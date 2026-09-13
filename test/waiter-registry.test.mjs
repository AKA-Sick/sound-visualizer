import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WaiterRegistry } from '../src/renderer/audio/waiter-registry.js';

describe('WaiterRegistry', () => {
  it('resolves all waiters registered for the same key with the same value', async () => {
    const reg = new WaiterRegistry();
    const p1 = reg.wait('hash1');
    const p2 = reg.wait('hash1');
    reg.resolveAll('hash1', { title: 'done' });
    assert.deepEqual(await p1, { title: 'done' });
    assert.deepEqual(await p2, { title: 'done' });
  });

  it('rejects all waiters registered for the same key with the same error', async () => {
    const reg = new WaiterRegistry();
    const p1 = reg.wait('hash1');
    reg.rejectAll('hash1', new Error('boom'));
    await assert.rejects(p1, /boom/);
  });

  it('resolving a key with no waiters is a no-op', () => {
    const reg = new WaiterRegistry();
    assert.doesNotThrow(() => reg.resolveAll('nobody-waiting', 'value'));
  });

  it('does not resolve waiters registered for a different key', async () => {
    const reg = new WaiterRegistry();
    const p1 = reg.wait('hash1');
    reg.resolveAll('hash2', 'wrong');
    reg.resolveAll('hash1', 'right');
    assert.equal(await p1, 'right');
  });
});
