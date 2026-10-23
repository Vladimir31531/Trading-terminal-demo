import type { Candle } from '../domain/market';
import {
  type SimulationSettings,
  type SimulationSnapshot,
  validateSimulationSettings,
  validateSimulationSpeed,
} from '../domain/simulation';
import type { MarketRepository } from './market-repository';

const PAGE_SIZE = 800;
const PREFETCH_REMAINING = 200;

export interface SimulationScheduler {
  now(): number;
  request(callback: (timestamp: number) => void): number;
  cancel(id: number): void;
}

const browserScheduler: SimulationScheduler = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/** Replays available source seconds; a market closure never produces empty ticks. */
export class SimulationEngine {
  readonly id = crypto.randomUUID();
  readonly settings: Readonly<SimulationSettings>;
  private snapshot: SimulationSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly candleListeners = new Set<(candles: Candle[]) => void>();
  private readonly controller = new AbortController();
  private page: Candle[] = [];
  private nextPage: Candle[] | undefined;
  private index = 0;
  private after: number | undefined;
  private hasMore = true;
  private fetching = false;
  private started = false;
  private delivered = false;
  private disposed = false;
  private wantsPlay = true;
  private holds = 0;
  private hidden = typeof document !== 'undefined' && document.hidden;
  private frame: number | undefined;
  private lastFrame: number | undefined;
  private budget = 0;

  constructor(
    readonly datasetId: string,
    settings: SimulationSettings,
    private readonly source: Pick<MarketRepository, 'loadSeconds'>,
    private readonly scheduler: SimulationScheduler = browserScheduler,
  ) {
    // Instrument bounds are checked by the session form; keep engine invariants too.
    validateSimulationSettings(settings, {
      firstTime: settings.startTime,
      lastTime: settings.endTime,
    });
    this.settings = Object.freeze({ ...settings });
    this.snapshot = {
      status: 'loading',
      time: settings.startTime,
      speed: settings.speed,
    };
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', this.visibilityChanged);
  }

  getSnapshot = (): SimulationSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onCandles(listener: (candles: Candle[]) => void): () => void {
    this.candleListeners.add(listener);
    return () => this.candleListeners.delete(listener);
  }

  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.fetchPage();
  }

  play(): void {
    if (this.ended()) return;
    this.wantsPlay = true;
    if (!this.started) this.start();
    this.resume();
  }

  pause(): void {
    if (this.ended()) return;
    this.settle(this.scheduler.now());
    this.wantsPlay = false;
    this.cancelFrame();
    this.updateStatus();
  }

  setSpeed(speed: number): void {
    validateSimulationSpeed(speed);
    if (this.disposed || speed === this.snapshot.speed) return;
    this.settle(this.scheduler.now());
    this.publish({ speed });
  }

  /** Freeze replay during chart reloads without changing the user's Play/Pause intent. */
  hold(): () => void {
    if (!this.holds) this.settle(this.scheduler.now());
    this.holds++;
    this.cancelFrame();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (!this.holds) this.resume();
    };
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.cancelFrame();
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.listeners.clear();
    this.candleListeners.clear();
    this.page = [];
    this.nextPage = undefined;
  }

  private readonly visibilityChanged = () => {
    this.hidden = document.hidden;
    // Background time is not a backlog of prices to reveal on tab return.
    this.cancelFrame();
    if (!this.hidden) this.resume();
  };

  private ended(): boolean {
    return (
      this.disposed ||
      this.snapshot.status === 'finished' ||
      this.snapshot.status === 'error'
    );
  }

  private remaining(): number {
    return this.page.length - this.index;
  }

  private clockRunning(): boolean {
    return (
      !this.ended() &&
      this.started &&
      this.wantsPlay &&
      !this.holds &&
      !this.hidden &&
      this.delivered &&
      this.remaining() > 0
    );
  }

  private publish(change: Partial<SimulationSnapshot>): void {
    if (
      Object.entries(change).every(
        ([key, value]) =>
          this.snapshot[key as keyof SimulationSnapshot] === value,
      )
    )
      return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  private updateStatus(): void {
    if (this.ended()) return;
    this.publish({
      status: !this.wantsPlay
        ? 'paused'
        : this.delivered && this.remaining() > 0
          ? 'playing'
          : 'loading',
    });
  }

  private schedule(): void {
    if (!this.clockRunning() || this.frame !== undefined) return;
    this.lastFrame ??= this.scheduler.now();
    this.frame = this.scheduler.request(this.onFrame);
  }

  private cancelFrame(): void {
    if (this.frame !== undefined) this.scheduler.cancel(this.frame);
    this.frame = undefined;
    this.lastFrame = undefined;
  }

  private readonly onFrame = (timestamp: number) => {
    this.frame = undefined;
    this.settle(timestamp);
    this.schedule();
  };

  private settle(timestamp: number): void {
    if (!this.clockRunning() || this.lastFrame === undefined) return;
    this.budget +=
      (Math.max(0, timestamp - this.lastFrame) / 1000) * this.snapshot.speed;
    this.lastFrame = timestamp;
    const count = Math.min(Math.floor(this.budget), PAGE_SIZE);
    if (!count) return;
    const candles: Candle[] = [];
    while (candles.length < count && this.remaining()) {
      candles.push(this.page[this.index++]);
      if (!this.remaining() && this.nextPage) this.promotePage();
    }
    this.budget -= candles.length;
    this.deliver(candles);
    if (this.ended()) return;
    this.prefetch();
    if (!this.remaining()) {
      this.cancelFrame();
      // Network latency is buffering, not simulated elapsed time.
      this.budget = 0;
      if (!this.hasMore && !this.fetching) this.finish();
      else this.updateStatus();
    }
  }

  private deliver(candles: Candle[]): void {
    if (!candles.length || this.disposed) return;
    this.snapshot = {
      ...this.snapshot,
      time: candles[candles.length - 1].time,
    };
    for (const listener of this.candleListeners) listener(candles);
    for (const listener of this.listeners) listener();
  }

  private promotePage(): void {
    if (!this.nextPage) return;
    this.page = this.nextPage;
    this.nextPage = undefined;
    this.index = 0;
  }

  private resume(): void {
    if (this.ended()) return;
    if (
      !this.delivered &&
      this.wantsPlay &&
      !this.holds &&
      !this.hidden &&
      this.remaining()
    ) {
      this.delivered = true;
      this.deliver([this.page[this.index++]]);
    }
    if (!this.remaining() && !this.hasMore && !this.fetching) {
      if (this.delivered) this.finish();
      else this.fail(new Error('В выбранном периоде нет секундных данных.'));
      return;
    }
    this.updateStatus();
    this.prefetch();
    this.schedule();
  }

  private prefetch(): void {
    if (
      !this.ended() &&
      this.hasMore &&
      !this.fetching &&
      !this.nextPage &&
      this.remaining() <= PREFETCH_REMAINING
    )
      this.fetchPage();
  }

  private fetchPage(): void {
    if (this.ended() || this.fetching || !this.hasMore) return;
    this.fetching = true;
    void this.source
      .loadSeconds(
        this.datasetId,
        this.settings.startTime,
        this.settings.endTime,
        this.after,
        PAGE_SIZE,
        this.controller.signal,
      )
      .then((page) => {
        if (this.disposed) return;
        this.fetching = false;
        this.hasMore = page.hasMore && page.candles.length > 0;
        this.after = page.candles.at(-1)?.time ?? this.after;
        this.nextPage = page.candles;
        if (!this.remaining()) this.promotePage();
        this.resume();
      })
      .catch((cause: unknown) => {
        if (this.disposed) return;
        this.fetching = false;
        this.fail(cause);
      });
  }

  private finish(): void {
    this.cancelFrame();
    this.publish({ status: 'finished' });
  }

  private fail(cause: unknown): void {
    this.cancelFrame();
    this.publish({
      status: 'error',
      error:
        cause instanceof Error
          ? cause.message
          : 'Не удалось прочитать секундные данные симуляции.',
    });
  }
}
