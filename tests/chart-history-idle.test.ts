import { describe, expect, test } from 'bun:test';
import { waitForHistoryIdle } from '../src/chart/history-idle';

function frameScheduler() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const cancelled: (() => void)[] = [];
  return {
    scheduler: {
      request(callback: () => void) {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id: number) {
        const callback = callbacks.get(id);
        if (callback) cancelled.push(callback);
        callbacks.delete(id);
      },
    },
    frame() {
      const current = [...callbacks.values()];
      callbacks.clear();
      for (const callback of current) callback();
    },
    pending: () => callbacks.size,
    cancelled,
  };
}

describe('waiting to apply chart history', () => {
  test('a held drag blocks changes until two stable frames after release', async () => {
    const frames = frameScheduler();
    let interacting = true;
    const idle = waitForHistoryIdle(
      () => ({ from: 40, to: 150 }),
      () => interacting,
      frames.scheduler,
    );
    frames.frame();
    frames.frame();
    frames.frame();
    expect(frames.pending()).toBe(1);

    interacting = false;
    frames.frame();
    expect(frames.pending()).toBe(1);
    frames.frame();
    expect(await idle.ready).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  test('remaining kinetic motion keeps waiting after the pointer is released', async () => {
    const frames = frameScheduler();
    const range = { from: 40, to: 150 };
    const idle = waitForHistoryIdle(
      () => range,
      () => false,
      frames.scheduler,
    );
    frames.frame();
    // The chart may reuse its range object; sample coordinates, not its identity.
    for (let step = 0; step < 10; step++) {
      range.from += 0.25;
      range.to += 0.25;
      frames.frame();
      expect(frames.pending()).toBe(1);
    }
    frames.frame();
    expect(await idle.ready).toBe(true);
    expect(frames.pending()).toBe(0);
  });

  test('a new gesture resets the stable range observed before it', async () => {
    const frames = frameScheduler();
    let interacting = false;
    const idle = waitForHistoryIdle(
      () => ({ from: 40, to: 150 }),
      () => interacting,
      frames.scheduler,
    );
    frames.frame();
    interacting = true;
    frames.frame();
    frames.frame();
    expect(frames.pending()).toBe(1);

    interacting = false;
    frames.frame();
    expect(frames.pending()).toBe(1);
    frames.frame();
    expect(await idle.ready).toBe(true);
  });

  test('an unavailable range is not considered a settled chart', async () => {
    const frames = frameScheduler();
    let range: { from: number; to: number } | null = null;
    const idle = waitForHistoryIdle(
      () => range,
      () => false,
      frames.scheduler,
    );
    frames.frame();
    frames.frame();
    expect(frames.pending()).toBe(1);

    range = { from: 40, to: 150 };
    frames.frame();
    expect(frames.pending()).toBe(1);
    frames.frame();
    expect(await idle.ready).toBe(true);
  });

  test('cancellation prevents a stale page from applying and unschedules its frame', async () => {
    const frames = frameScheduler();
    let applied = false;
    const idle = waitForHistoryIdle(
      () => ({ from: 40, to: 150 }),
      () => false,
      frames.scheduler,
    );
    const apply = idle.ready.then((ready) => {
      if (ready) applied = true;
    });
    frames.frame();
    idle.cancel();
    idle.cancel();
    expect(await idle.ready).toBe(false);
    await apply;
    expect(frames.pending()).toBe(0);
    expect(frames.cancelled).toHaveLength(1);
    // Even an already-dispatched callback cannot revive a cancelled request.
    frames.cancelled[0]();
    frames.frame();
    expect(applied).toBe(false);
    expect(frames.pending()).toBe(0);
  });
});
