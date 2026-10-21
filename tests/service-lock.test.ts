import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireServiceLock } from '../server/service-lock';

const directories: string[] = [];
const locks: ReturnType<typeof acquireServiceLock>[] = [];

async function directory(): Promise<string> {
  const result = await mkdtemp(join(tmpdir(), 'terminal-service-lock-'));
  directories.push(result);
  return result;
}

function acquire(dataDir: string) {
  const lock = acquireServiceLock(dataDir);
  locks.push(lock);
  return lock;
}

afterEach(async () => {
  for (const lock of locks.splice(0)) lock.close();
  for (const path of directories.splice(0)) {
    if (
      dirname(resolve(path)) !== resolve(tmpdir()) ||
      !basename(path).startsWith('terminal-service-lock-')
    )
      throw new Error('Unexpected cleanup target');
    await rm(path, { recursive: true, force: true });
  }
});

test('rejects a second owner of the same project data directory', async () => {
  const path = await directory();
  acquire(path);
  expect(() => acquire(path)).toThrow('Terminal-demo уже работает');
});

test('releases ownership when the first connection closes', async () => {
  const path = await directory();
  acquire(path).close();
  expect(() => acquire(path)).not.toThrow();
  expect(() => acquire(path)).toThrow('Terminal-demo уже работает');
});

test('allows independent projects to run concurrently', async () => {
  const first = await directory();
  const second = await directory();
  acquire(first);
  expect(() => acquire(second)).not.toThrow();
});
