import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedMap, approxBytes } from '../src/bounded.mjs';
import { REPLAY_LIMITS, planReplay, retainForReplay } from '../src/claude/convert.mjs';

test('kept conversations are bounded by total size as well as by count (oldest out first)', () => {
  const m = new BoundedMap({ maxEntries: 10, maxBytes: 1000 });
  m.set('a', 'x', 400);
  m.set('b', 'y', 400);
  m.set('c', 'z', 400);
  assert.deepEqual([m.has('a'), m.has('b'), m.has('c')], [false, true, true]);
  assert.equal(m.bytes, 800);
  assert.equal(m.set('huge', 'w', 5000), false, 'one entry larger than the whole budget is not kept');
  assert.equal(m.has('huge'), false);
  m.set('b', 'y2', 100);
  assert.equal(m.bytes, 500, 'replacing an entry replaces its size');
  const n = new BoundedMap({ maxEntries: 2, maxBytes: 1e9 });
  for (const k of ['1', '2', '3']) n.set(k, k);
  assert.deepEqual([n.has('1'), n.size], [false, 2]);
  assert.ok(approxBytes({ s: 'x'.repeat(1000) }) > 2000);
});

test('a stored conversation keeps only the images a replay can use; fingerprints and hashes stay', () => {
  const img = (n) => ({ kind: 'image', mime: 'image/png', data: `data-${n}-${'A'.repeat(1000)}` });
  const items = [];
  for (let i = 0; i < 30; i += 1) items.push({ kind: 'output', callType: 'function', callId: `c${i}`, blocks: [img(i)], hash: `h${i}`, fp: `o:c${i}` });
  const kept = retainForReplay(items);
  const images = kept.flatMap((i) => i.blocks).filter((b) => b.kind === 'image');
  assert.equal(images.length, REPLAY_LIMITS.maxImages);
  assert.equal(images.at(-1).data, items.at(-1).blocks[0].data, 'the newest are kept');
  assert.deepEqual(kept.map((i) => [i.fp, i.hash]), items.map((i) => [i.fp, i.hash]));
  // what a replay renders is the same before and after
  assert.deepEqual(planReplay(kept).rendered, planReplay(items).rendered);
  assert.equal(retainForReplay(kept), kept, 'nothing more to drop: the same array');
});

test('a live conversation keeps tool outputs only at the size a replay gives them at their age', () => {
  const items = [];
  for (let i = 0; i < 40; i += 1) items.push({ kind: 'output', callType: 'function', callId: `c${i}`, blocks: [{ kind: 'text', text: `${i}:`.padEnd(300_000, 'x') }], hash: `h${i}`, fp: `o:c${i}` });
  const kept = retainForReplay(items);
  const sizes = kept.map((i) => i.blocks.reduce((n, b) => n + b.text.length, 0));
  assert.ok(sizes.slice(-REPLAY_LIMITS.recentOutputs).every((n) => n <= REPLAY_LIMITS.recentOutputChars + 300), 'recent: the larger cap');
  assert.ok(sizes.slice(0, -REPLAY_LIMITS.recentOutputs).every((n) => n <= REPLAY_LIMITS.olderOutputChars + 300), 'older: the smaller cap');
  assert.deepEqual(planReplay(kept).rendered, planReplay(items).rendered, 'a replay renders exactly the same');
  // as more outputs arrive, the ones that age are cut further
  const later = retainForReplay([...kept, ...items.slice(0, 12).map((x, i) => ({ ...x, callId: `n${i}`, fp: `o:n${i}` }))]);
  assert.ok(later.slice(0, 40).every((i) => i.blocks.reduce((n, b) => n + b.text.length, 0) <= REPLAY_LIMITS.olderOutputChars + 300));
  // images: by count and by total size
  const big = (n) => ({ kind: 'message', role: 'user', blocks: [{ kind: 'image', mime: 'image/png', data: 'A'.repeat(10 * 1024 * 1024) }], fp: `m:${n}` });
  const imgs = retainForReplay([big(1), big(2), big(3), big(4)]);
  assert.equal(imgs.flatMap((i) => i.blocks).filter((b) => b.kind === 'image').length, 2, '24 MiB of image data at most');
});
