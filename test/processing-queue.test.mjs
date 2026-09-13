import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessingQueue } from '../src/renderer/audio/processing-queue.js';

describe('ProcessingQueue', () => {
  it('dequeues in FIFO order', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    assert.equal(q.next(), 'a');
    assert.equal(q.next(), 'b');
    assert.equal(q.next(), 'c');
    assert.equal(q.next(), null);
  });

  it('does not enqueue the same hash twice', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('a');
    assert.equal(q.size, 1);
  });

  it('jumpToFront moves an existing mid-queue item to the front', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    q.jumpToFront('c');
    assert.equal(q.next(), 'c');
    assert.equal(q.next(), 'a');
    assert.equal(q.next(), 'b');
  });

  it('jumpToFront on a not-yet-enqueued hash adds it at the front', () => {
    const q = new ProcessingQueue();
    q.enqueue('a');
    q.jumpToFront('z');
    assert.equal(q.next(), 'z');
    assert.equal(q.next(), 'a');
  });

  it('remove takes a hash out without disturbing the order of the rest', () => {
    const q = new ProcessingQueue();
    q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
    q.remove('b');
    assert.equal(q.next(), 'a');
    assert.equal(q.next(), 'c');
  });

  it('isEmpty reflects queue state', () => {
    const q = new ProcessingQueue();
    assert.equal(q.isEmpty, true);
    q.enqueue('a');
    assert.equal(q.isEmpty, false);
    q.next();
    assert.equal(q.isEmpty, true);
  });
});
