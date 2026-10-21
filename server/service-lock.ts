import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** SQLite releases this OS lock even if the owning process is interrupted. */
export function acquireServiceLock(dataDir: string): { close(): void } {
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(join(dataDir, 'service-lock.sqlite'), {
    create: true,
    strict: true,
  });
  try {
    database.run('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (cause) {
    database.close();
    if (
      cause instanceof Error &&
      'code' in cause &&
      cause.code === 'SQLITE_BUSY'
    ) {
      throw new Error(
        'Terminal-demo уже работает с этой папкой проекта. Используйте адрес первого сервиса или остановите его через Ctrl+C перед сменой порта.',
      );
    }
    throw cause;
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}
