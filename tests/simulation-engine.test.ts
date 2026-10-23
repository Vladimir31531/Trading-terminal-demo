import { describe, expect, test } from 'bun:test';
import type { MarketRepository } from '../src/application/market-repository';
import {
  SimulationEngine,
  type SimulationScheduler,
} from '../src/application/simulation-engine';
import type { Candle, HistoryPage } from '../src/domain/market';
import {
  aggregateReplayCandle,
  type SimulationSettings,
  validateSimulationSettings,
} from '../src/domain/simulation';

const candle = (time: number, close = time): Candle => ({
  time,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
});
const settings: SimulationSettings = {
  startTime: 100,
  endTime: 1000,
  speed: 1,
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

class Frames implements SimulationScheduler {
  private time = 0;
  private id = 0;
  private callbacks = new Map<number, (timestamp: number) => void>();
  now = () => this.time;
  request = (callback: (timestamp: number) => void) => {
    this.callbacks.set(++this.id, callback);
    return this.id;
  };
  cancel = (id: number) => {
    this.callbacks.delete(id);
  };
  elapse(milliseconds: number) {
    this.time += milliseconds;
  }
  advance(milliseconds: number) {
    this.elapse(milliseconds);
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }
  get pending() {
    return this.callbacks.size;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const page = (candles: Candle[], hasMore = false): HistoryPage => ({
  candles,
  hasMore,
  hasNewer: false,
});

function source(candles: Candle[]) {
  const requests: { after?: number; limit?: number; signal?: AbortSignal }[] =
    [];
  const repository: Pick<MarketRepository, 'loadSeconds'> = {
    async loadSeconds(_dataset, from, through, after, limit = 800, signal) {
      requests.push({ after, limit, signal });
      const available = candles.filter(
        (bar) =>
          bar.time >= from &&
          bar.time <= through &&
          (after === undefined || bar.time > after),
      );
      return page(available.slice(0, limit), available.length > limit);
    },
  };
  return { repository, requests };
}

describe('simulation settings and replay aggregation', () => {
  const bounds = { firstTime: 100, lastTime: 1000 };

  test('accepts inclusive bounds and finite positive speeds without a fixed maximum', () => {
    expect(() => validateSimulationSettings(settings, bounds)).not.toThrow();
    for (const speed of [0.01, 2, 10, 100_000])
      expect(() =>
        validateSimulationSettings({ ...settings, speed }, bounds),
      ).not.toThrow();
  });

  test.each([
    { startTime: Number.NaN },
    { endTime: Number.POSITIVE_INFINITY },
    { startTime: 99 },
    { endTime: 1001 },
    { endTime: 100 },
    { startTime: 1001 },
    { speed: 0 },
    { speed: -1 },
    { speed: Number.NaN },
    { speed: Number.POSITIVE_INFINITY },
  ])('rejects invalid dates, range or speed: %j', (change) => {
    expect(() =>
      validateSimulationSettings({ ...settings, ...change }, bounds),
    ).toThrow();
  });

  test('retains actual second OHLC, ending price always comes from Close', () => {
    const first = { time: 120, open: 10, high: 16, low: 8, close: 12 };
    const second = { time: 121, open: 12, high: 17, low: 9, close: 11 };
    const initial = aggregateReplayCandle(undefined, first, '1m');
    expect(aggregateReplayCandle(initial, second, '1m')).toEqual({
      time: 120,
      open: 10,
      high: 17,
      low: 8,
      close: 11,
    });
    expect(initial).toEqual(first);
  });

  test('starts a new UTC candle at timeframe boundaries, including calendar months', () => {
    const previous = candle(Date.parse('2026-01-31T23:59:59Z') / 1000);
    const next = candle(Date.parse('2026-02-01T00:00:00Z') / 1000, 20);
    expect(aggregateReplayCandle(previous, next, '1M')).toEqual(next);
    expect(aggregateReplayCandle(candle(120), candle(180), '1m')).toEqual(
      candle(180),
    );
  });
});

describe('simulation engine', () => {
  test('delivers the first available second immediately, then batches elapsed ticks', async () => {
    const frames = new Frames();
    const data = source(
      Array.from({ length: 20 }, (_, index) => candle(103 + index)),
    );
    const engine = new SimulationEngine(
      'dataset',
      settings,
      data.repository,
      frames,
    );
    const batches: Candle[][] = [];
    engine.onCandles((candles) => batches.push(candles));
    const initial = engine.getSnapshot();
    expect(initial.time).toBe(100);
    expect(engine.getSnapshot()).toBe(initial);
    engine.start();
    engine.start();
    await flush();
    expect(batches.map((batch) => batch.map((bar) => bar.time))).toEqual([
      [103],
    ]);
    expect(engine.getSnapshot()).toMatchObject({
      status: 'playing',
      time: 103,
    });
    frames.advance(999);
    expect(engine.getSnapshot().time).toBe(103);
    frames.advance(3001);
    expect(batches[1].map((bar) => bar.time)).toEqual([104, 105, 106, 107]);
    expect(data.requests).toHaveLength(1);
    engine.destroy();
  });

  test('changes speed using elapsed time at the old rate and retains fractional progress', async () => {
    const frames = new Frames();
    const data = source([100, 101, 102, 103].map((time) => candle(time)));
    const engine = new SimulationEngine(
      'dataset',
      settings,
      data.repository,
      frames,
    );
    engine.start();
    await flush();
    frames.elapse(500);
    engine.setSpeed(2);
    frames.advance(250);
    expect(engine.getSnapshot()).toMatchObject({ time: 101, speed: 2 });
    engine.pause();
    frames.advance(60_000);
    expect(engine.getSnapshot()).toMatchObject({ time: 101, status: 'paused' });
    engine.play();
    frames.advance(500);
    expect(engine.getSnapshot().time).toBe(102);
    expect(engine.settings.speed).toBe(1);
    engine.destroy();
  });

  test('pause freezes a partially elapsed second and resumes without catching up', async () => {
    const frames = new Frames();
    const data = source([100, 101, 102].map((time) => candle(time)));
    const engine = new SimulationEngine(
      'dataset',
      settings,
      data.repository,
      frames,
    );
    engine.start();
    await flush();
    frames.elapse(400);
    engine.pause();
    frames.elapse(100_000);
    engine.play();
    frames.advance(599);
    expect(engine.getSnapshot().time).toBe(100);
    frames.advance(1);
    expect(engine.getSnapshot().time).toBe(101);
    engine.destroy();
  });

  test('nested chart holds block even the initial tick and releases are idempotent', async () => {
    const frames = new Frames();
    const data = source([100, 101, 102].map((time) => candle(time)));
    const engine = new SimulationEngine(
      'dataset',
      settings,
      data.repository,
      frames,
    );
    const received: Candle[] = [];
    engine.onCandles((candles) => received.push(...candles));
    const releaseFirst = engine.hold();
    const releaseSecond = engine.hold();
    engine.start();
    await flush();
    expect(received).toEqual([]);
    expect(frames.pending).toBe(0);
    frames.elapse(1_000_000);
    releaseFirst();
    releaseFirst();
    expect(received).toEqual([]);
    releaseSecond();
    expect(received.map((bar) => bar.time)).toEqual([100]);
    frames.advance(1000);
    expect(received.map((bar) => bar.time)).toEqual([100, 101]);
    engine.destroy();
  });

  test('a hold retains Play/Pause intent and discards time spent rebuilding a chart', async () => {
    const frames = new Frames();
    const data = source([100, 101, 102].map((time) => candle(time)));
    const engine = new SimulationEngine(
      'dataset',
      settings,
      data.repository,
      frames,
    );
    engine.start();
    await flush();
    frames.advance(200);
    const release = engine.hold();
    frames.elapse(80_000);
    engine.pause();
    release();
    expect(engine.getSnapshot()).toMatchObject({ time: 100, status: 'paused' });
    expect(frames.pending).toBe(0);
    engine.play();
    frames.advance(800);
    expect(engine.getSnapshot().time).toBe(101);
    engine.destroy();
  });

  test('jumps to the next available record across market closures and stops at end', async () => {
    const frames = new Frames();
    const data = source([99, 100, 1000, 1001].map((time) => candle(time)));
    const engine = new SimulationEngine(
      'dataset',
      settings,
      data.repository,
      frames,
    );
    const received: number[] = [];
    engine.onCandles((candles) =>
      received.push(...candles.map((bar) => bar.time)),
    );
    engine.start();
    await flush();
    frames.advance(1000);
    expect(received).toEqual([100, 1000]);
    expect(engine.getSnapshot()).toMatchObject({
      time: 1000,
      status: 'finished',
    });
    expect(frames.pending).toBe(0);
    engine.play();
    frames.advance(10_000);
    expect(received).toEqual([100, 1000]);
    engine.destroy();
  });

  test('prefetches only one bounded page and uses exclusive source cursors', async () => {
    const frames = new Frames();
    const data = source(
      Array.from({ length: 2500 }, (_, index) => candle(100 + index)),
    );
    const engine = new SimulationEngine(
      'dataset',
      { ...settings, endTime: 3000, speed: 1000 },
      data.repository,
      frames,
    );
    engine.start();
    await flush();
    expect(data.requests.map((request) => request.after)).toEqual([undefined]);
    frames.advance(600);
    await flush();
    expect(data.requests.map((request) => request.after)).toEqual([
      undefined,
      899,
    ]);
    frames.advance(0);
    await flush();
    expect(data.requests).toHaveLength(2);
    frames.advance(800);
    await flush();
    expect(data.requests.map((request) => request.after)).toEqual([
      undefined,
      899,
      1699,
    ]);
    expect(data.requests.every((request) => request.limit === 800)).toBe(true);
    engine.destroy();
  });

  test('network buffering freezes the clock and resumes without a price burst', async () => {
    const frames = new Frames();
    const next = deferred<HistoryPage>();
    let calls = 0;
    const repository: Pick<MarketRepository, 'loadSeconds'> = {
      loadSeconds: async () => {
        calls++;
        return calls === 1
          ? page([candle(100), candle(101)], true)
          : next.promise;
      },
    };
    const engine = new SimulationEngine(
      'dataset',
      settings,
      repository,
      frames,
    );
    engine.start();
    await flush();
    expect(calls).toBe(2);
    frames.advance(1000);
    expect(engine.getSnapshot()).toMatchObject({
      time: 101,
      status: 'loading',
    });
    frames.elapse(90_000);
    next.resolve(page([candle(102), candle(103)]));
    await flush();
    expect(engine.getSnapshot()).toMatchObject({
      time: 101,
      status: 'playing',
    });
    frames.advance(999);
    expect(engine.getSnapshot().time).toBe(101);
    frames.advance(1);
    expect(engine.getSnapshot().time).toBe(102);
    engine.destroy();
  });

  test('delivers the inclusive last record across a page boundary before finishing', async () => {
    const frames = new Frames();
    const data = source(
      Array.from({ length: 802 }, (_, index) => candle(100 + index)),
    );
    const engine = new SimulationEngine(
      'dataset',
      { ...settings, endTime: 900, speed: 1000 },
      data.repository,
      frames,
    );
    const received: number[] = [];
    engine.onCandles((candles) =>
      received.push(...candles.map((bar) => bar.time)),
    );
    engine.start();
    await flush();
    frames.advance(600);
    await flush();
    frames.advance(200);
    expect(received).toEqual(
      Array.from({ length: 801 }, (_, index) => 100 + index),
    );
    expect(engine.getSnapshot()).toMatchObject({
      time: 900,
      status: 'finished',
    });
    expect(frames.pending).toBe(0);
    engine.destroy();
  });

  test('background visibility suspends replay without a backlog on return', async () => {
    class Visibility extends EventTarget {
      hidden = false;
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const visibility = new Visibility();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: visibility,
    });
    const frames = new Frames();
    const engine = new SimulationEngine(
      'dataset',
      settings,
      source([candle(100), candle(101), candle(102)]).repository,
      frames,
    );
    try {
      engine.start();
      await flush();
      frames.advance(400);
      visibility.hidden = true;
      visibility.dispatchEvent(new Event('visibilitychange'));
      expect(frames.pending).toBe(0);
      frames.elapse(100_000);
      visibility.hidden = false;
      visibility.dispatchEvent(new Event('visibilitychange'));
      frames.advance(599);
      expect(engine.getSnapshot().time).toBe(100);
      frames.advance(1);
      expect(engine.getSnapshot()).toMatchObject({
        time: 101,
        status: 'playing',
      });
    } finally {
      engine.destroy();
      if (original) Object.defineProperty(globalThis, 'document', original);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  test('pause while buffering prevents playback when the page arrives', async () => {
    const frames = new Frames();
    const loading = deferred<HistoryPage>();
    const engine = new SimulationEngine(
      'dataset',
      settings,
      { loadSeconds: () => loading.promise },
      frames,
    );
    engine.start();
    engine.pause();
    loading.resolve(page([candle(103), candle(104)]));
    await flush();
    expect(engine.getSnapshot()).toMatchObject({ time: 100, status: 'paused' });
    expect(frames.pending).toBe(0);
    engine.play();
    expect(engine.getSnapshot()).toMatchObject({
      time: 103,
      status: 'playing',
    });
    frames.advance(1000);
    expect(engine.getSnapshot()).toMatchObject({
      time: 104,
      status: 'finished',
    });
    engine.destroy();
  });

  test('reports missing seconds and read failures instead of silently continuing', async () => {
    const frames = new Frames();
    const empty = new SimulationEngine(
      'dataset',
      settings,
      source([]).repository,
      frames,
    );
    empty.start();
    await flush();
    expect(empty.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'В выбранном периоде нет секундных данных.',
    });
    empty.destroy();
    const failure = new SimulationEngine(
      'dataset',
      settings,
      {
        loadSeconds: async () => {
          throw new Error('Исходный CSV-файл недоступен.');
        },
      },
      frames,
    );
    failure.start();
    await flush();
    expect(failure.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'Исходный CSV-файл недоступен.',
    });
    expect(frames.pending).toBe(0);
    failure.destroy();
  });

  test('destroy aborts pending I/O and late responses cannot emit prices', async () => {
    const frames = new Frames();
    const loading = deferred<HistoryPage>();
    let signal: AbortSignal | undefined;
    let received = 0;
    const engine = new SimulationEngine(
      'dataset',
      settings,
      {
        loadSeconds: (
          _dataset,
          _from,
          _through,
          _after,
          _limit,
          nextSignal,
        ) => {
          signal = nextSignal;
          return loading.promise;
        },
      },
      frames,
    );
    engine.onCandles(() => received++);
    engine.subscribe(() => received++);
    engine.start();
    engine.destroy();
    expect(signal?.aborted).toBe(true);
    loading.resolve(page([candle(100), candle(101)]));
    await flush();
    engine.play();
    frames.advance(10_000);
    expect(received).toBe(0);
    expect(frames.pending).toBe(0);
  });

  test('unsubscribed chart and UI listeners receive no further events', async () => {
    const frames = new Frames();
    const engine = new SimulationEngine(
      'dataset',
      settings,
      source([candle(100), candle(101), candle(102)]).repository,
      frames,
    );
    let candles = 0;
    let snapshots = 0;
    const removeCandles = engine.onCandles(() => candles++);
    const removeSnapshot = engine.subscribe(() => snapshots++);
    engine.start();
    await flush();
    expect(candles).toBe(1);
    const previousSnapshots = snapshots;
    removeCandles();
    removeSnapshot();
    frames.advance(1000);
    expect(candles).toBe(1);
    expect(snapshots).toBe(previousSnapshots);
    expect(engine.getSnapshot().time).toBe(101);
    engine.destroy();
  });

  test('rejects invalid live speed changes without altering replay', async () => {
    const frames = new Frames();
    const engine = new SimulationEngine(
      'dataset',
      settings,
      source([candle(100), candle(101)]).repository,
      frames,
    );
    engine.start();
    await flush();
    for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => engine.setSpeed(speed)).toThrow();
    expect(engine.getSnapshot().speed).toBe(1);
    engine.destroy();
  });
});
