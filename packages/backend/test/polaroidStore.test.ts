import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PolaroidStore } from '../src/polaroidStore.ts';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe('PolaroidStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'singpulse-polaroids-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists photos across a reload', async () => {
    const store = new PolaroidStore(dir);
    await store.load();
    const item = await store.add({ buffer: jpeg, ext: 'jpg', sender: 'Alice', caption: 'ENCORE' });
    assert.match(item.imageUrl, /^\/media\/polaroids\/[0-9a-f-]{36}\.jpg$/);
    assert.ok(Math.abs(item.rotationDeg) <= 6);

    const reloaded = new PolaroidStore(dir);
    await reloaded.load();
    assert.deepEqual(reloaded.latest(), [item]);
  });

  it('removes the entry and its file', async () => {
    const store = new PolaroidStore(dir);
    await store.load();
    const item = await store.add({ buffer: jpeg, ext: 'webp', sender: 'Bob' });

    assert.equal(store.count(), 1);
    assert.equal(await store.remove(item.id), true);
    assert.equal(await store.remove(item.id), false);
    assert.deepEqual(store.latest(), []);
    assert.equal(store.count(), 0);
    assert.deepEqual((await readdir(dir)).filter((f) => f !== 'index.json'), []);
  });

  it('rejects ids that are not uuids', async () => {
    const store = new PolaroidStore(dir);
    await store.load();
    assert.equal(await store.remove('../index'), false);
  });

  it('drops index entries with unsafe image paths on load', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'index.json'), JSON.stringify([
      { id: '11111111-1111-1111-1111-111111111111', imageUrl: '/media/polaroids/../../etc/passwd', sender: 'x', rotationDeg: 0, createdAt: 1 }
    ]));
    const store = new PolaroidStore(dir);
    await store.load();
    assert.deepEqual(store.latest(), []);
  });
});
