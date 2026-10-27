// packages/backend/src/polaroidStore.ts
//
// Persistent Polaroid wall: images and an index.json live under ${CACHE_DIR}/polaroids
// (served by the existing /media/ static mount), so photos survive restarts.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PolaroidItem } from '@singpulse/shared/types';

const MAX_STORED = 200;
const FILE_NAME_REGEX = /^[0-9a-f-]{36}\.(jpg|webp)$/;
const ID_REGEX = /^[0-9a-f-]{36}$/;

export type PolaroidImageExt = 'jpg' | 'webp';

export interface NewPolaroid {
  buffer: Buffer;
  ext: PolaroidImageExt;
  sender: string;
  caption?: string;
}

const isPolaroidItem = (value: unknown): value is PolaroidItem => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' && ID_REGEX.test(v.id) &&
    typeof v.imageUrl === 'string' &&
    FILE_NAME_REGEX.test(path.posix.basename(v.imageUrl)) &&
    typeof v.sender === 'string' &&
    typeof v.rotationDeg === 'number' &&
    typeof v.createdAt === 'number'
  );
};

export class PolaroidStore {
  private dir: string;
  private items: PolaroidItem[] = [];
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  public async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8'));
      if (Array.isArray(parsed)) this.items = parsed.filter(isPolaroidItem);
    } catch {
      this.items = [];
    }
  }

  public latest(count = 40): PolaroidItem[] {
    return this.items.slice(-count);
  }

  public count(): number {
    return this.items.length;
  }

  public add(input: NewPolaroid): Promise<PolaroidItem> {
    return this.enqueueWrite(async () => {
      const id = randomUUID();
      const fileName = `${id}.${input.ext}`;
      await writeFile(path.join(this.dir, fileName), input.buffer);
      const item: PolaroidItem = {
        id,
        imageUrl: `/media/polaroids/${fileName}`,
        sender: input.sender,
        ...(input.caption ? { caption: input.caption } : {}),
        rotationDeg: Math.round((randomInt(-600, 601) / 100) * 10) / 10,
        createdAt: Date.now()
      };
      this.items.push(item);
      const evicted = this.items.splice(0, Math.max(0, this.items.length - MAX_STORED));
      await this.persist();
      await Promise.all(evicted.map((old) => this.deleteFile(old)));
      return item;
    });
  }

  public remove(id: string): Promise<boolean> {
    if (!ID_REGEX.test(id)) return Promise.resolve(false);
    return this.enqueueWrite(async () => {
      const idx = this.items.findIndex((item) => item.id === id);
      const [gone] = idx === -1 ? [] : this.items.splice(idx, 1);
      if (!gone) return false;
      await this.persist();
      await this.deleteFile(gone);
      return true;
    });
  }

  // Serialises add/remove so index.json is never written concurrently
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    const target = path.join(this.dir, 'index.json');
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(this.items));
    await rename(tmp, target);
  }

  private async deleteFile(item: PolaroidItem): Promise<void> {
    const fileName = path.posix.basename(item.imageUrl);
    if (!FILE_NAME_REGEX.test(fileName)) return;
    await rm(path.join(this.dir, fileName), { force: true });
  }
}
