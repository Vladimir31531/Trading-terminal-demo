import { describe, expect, test } from 'bun:test';
import type { SimulationScheduler } from '../src/application/simulation-engine';
import { SimulationEngine } from '../src/application/simulation-engine';
import { TradingEngine } from '../src/application/trading-engine';
import type { Instrument } from '../src/domain/market';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  PendingTradeReview,
  TradingSession,
} from '../src/domain/trading';
import { calculateProfit, validateProtection } from '../src/domain/trading';

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

  advance(milliseconds: number): void {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

async function approveReviews(trading: TradingEngine): Promise<void> {
  let review = trading.getSnapshot().pendingTradeReviews?.[0];
  while (review) {
    await trading.saveTradeReview(review.trade.id, {});
    review = trading.getSnapshot().pendingTradeReviews?.[0];
  }
}

function createHarness(initialBalance = 1000, sessionId = 'session-1') {
  const candles = [
    { time: 100, open: 100, high: 100, low: 100, close: 100 },
    { time: 101, open: 100, high: 100, low: 99, close: 100 },
    { time: 102, open: 100, high: 101, low: 99.9, close: 100 },
  ];
  const frames = new Frames();
  const source = {
    async loadSeconds(
      _datasetId: string,
      from: number,
      through: number,
      after?: number,
    ) {
      return {
        candles: candles.filter(
          (candle) =>
            candle.time >= from &&
            candle.time <= through &&
            (after === undefined || candle.time > after),
        ),
        hasMore: false,
        hasNewer: false,
      };
    },
  };
  const instrument: Instrument = {
    id: 'instrument-1',
    ticker: 'TEST',
    datasetId: 'dataset-1',
    fileName: 'test.csv',
    fileSize: 1,
    rowCount: 3,
    firstTime: 100,
    lastTime: 102,
    createdAt: 1,
    pricePrecision: 1,
    pointSize: 0.1,
  };
  const session: TradingSession = {
    id: sessionId,
    instrumentId: instrument.id,
    datasetId: instrument.datasetId,
    ticker: instrument.ticker,
    startedAt: 100_000,
    tradeCount: 0,
    totalProfit: 0,
    initialBalance,
    balance: initialBalance,
    simulationStartTime: 100,
  };
  const closedTrades: ClosedTrade[] = [];
  const balanceEntries: BalanceHistoryEntry[] = [];
  const stagedReviews: PendingTradeReview[] = [];
  const history = {
    async stageClosedTrade(review: PendingTradeReview) {
      if (!stagedReviews.some((item) => item.trade.id === review.trade.id))
        stagedReviews.push(review);
    },
    async saveClosedTrade(trade: ClosedTrade, entry: BalanceHistoryEntry) {
      closedTrades.push(trade);
      balanceEntries.push(entry);
      const reviewIndex = stagedReviews.findIndex(
        (item) => item.trade.id === trade.id,
      );
      if (reviewIndex !== -1) stagedReviews.splice(reviewIndex, 1);
    },
    async finishSession() {},
  };
  const simulation = new SimulationEngine(
    instrument.datasetId,
    { startTime: 100, endTime: 102, speed: 1 },
    source,
    frames,
  );
  const trading = new TradingEngine(session, instrument, history);
  trading.setPointValuePer001(5);
  trading.connect(simulation);
  return {
    frames,
    simulation,
    trading,
    closedTrades,
    balanceEntries,
    stagedReviews,
    candles,
    history,
    instrument,
    session,
    source,
  };
}

describe('trading calculations and replay execution', () => {
  test('pauses a manual close and stages its execution without recording history before review', async () => {
    const {
      simulation,
      trading,
      frames,
      closedTrades,
      balanceEntries,
      stagedReviews,
    } = createHarness();
    await simulation.start();
    trading.openMarket('buy', 0.02);
    const order = trading.getSnapshot().orders[0];
    trading.closeOrder(order.id);
    await flush();

    expect(simulation.getSnapshot()).toMatchObject({
      status: 'paused',
      time: 100,
    });
    expect(trading.getSnapshot().orders).toHaveLength(0);
    expect(trading.getSnapshot().markers.map((marker) => marker.phase)).toEqual(
      ['open', 'close'],
    );
    expect(closedTrades).toHaveLength(0);
    expect(balanceEntries).toHaveLength(0);
    expect(stagedReviews).toHaveLength(1);
    const review = trading.getSnapshot().pendingTradeReviews?.[0];
    expect(review?.trade).toMatchObject({
      ticket: order.ticket,
      volume: 0.02,
      closeReason: 'manual',
    });
    expect(() => trading.openMarket('sell', 0.01)).toThrow(
      'Сначала заполните характеристики',
    );
    await expect(trading.checkpoint()).rejects.toThrow(
      'Сначала заполните характеристики',
    );
    frames.advance(60_000);
    expect(simulation.getSnapshot().time).toBe(100);

    if (!review) throw new Error('Expected a trade awaiting review.');
    await trading.saveTradeReview(review.trade.id, {
      setup: 'Отскок',
      result: 'По плану',
    });
    expect(closedTrades).toHaveLength(1);
    expect(closedTrades[0].characteristics).toEqual({
      setup: 'Отскок',
      result: 'По плану',
    });
    expect(balanceEntries).toHaveLength(1);
    expect(stagedReviews).toHaveLength(0);
    expect(trading.getSnapshot().pendingTradeReviews).toHaveLength(0);
    expect(simulation.getSnapshot().status).toBe('paused');
    simulation.destroy();
  });

  test('interrupts a high-speed batch at the exact stop-loss second before future candles are shown', async () => {
    const { simulation, trading, frames, closedTrades, stagedReviews } =
      createHarness();
    const delivered: number[][] = [];
    simulation.onCandles((candles) =>
      delivered.push(candles.map((candle) => candle.time)),
    );
    await simulation.start();
    trading.openMarket('buy', 0.01);
    trading.setProtection(trading.getSnapshot().orders[0].id, 'stopLoss', 99.5);
    simulation.setSpeed(10_000);
    frames.advance(1000);
    await flush();

    expect(simulation.getSnapshot()).toMatchObject({
      status: 'paused',
      time: 101,
    });
    expect(trading.getSnapshot().currentTime).toBe(101);
    expect(delivered).toEqual([[100], [101]]);
    expect(closedTrades).toHaveLength(0);
    expect(stagedReviews).toHaveLength(1);
    expect(trading.getSnapshot().pendingTradeReviews?.[0].trade).toMatchObject({
      closeReason: 'stop-loss',
      closedAt: 101,
      exitPrice: 99.5,
      profit: -25,
    });
    frames.advance(10_000);
    expect(simulation.getSnapshot().time).toBe(101);
    await approveReviews(trading);
    expect(simulation.getSnapshot().status).toBe('paused');
    simulation.play();
    frames.advance(1);
    await flush();
    expect(delivered).toEqual([[100], [101], [102]]);
    expect(simulation.getSnapshot().status).toBe('finished');
    simulation.destroy();
  });

  test('reviews simultaneous final closures in sequence and saves each selection once', async () => {
    const { simulation, trading, closedTrades, balanceEntries, stagedReviews } =
      createHarness();
    await simulation.start();
    trading.openMarket('buy', 0.01);
    trading.openMarket('sell', 0.02);
    await trading.finish(100);
    await trading.finish(100);
    const reviews = trading.getSnapshot().pendingTradeReviews ?? [];
    expect(reviews).toHaveLength(2);
    expect(reviews.map((review) => review.balanceEntry.sequence)).toEqual([
      1, 2,
    ]);
    expect(reviews.map((review) => review.trade.closeReason)).toEqual([
      'simulation-end',
      'simulation-end',
    ]);
    expect(stagedReviews).toHaveLength(2);
    expect(closedTrades).toHaveLength(0);
    await expect(
      trading.saveTradeReview(reviews[1].trade.id, { setup: 'Второй' }),
    ).rejects.toThrow('Сначала сохраните характеристики предыдущей сделки');
    await trading.saveTradeReview(reviews[0].trade.id, { setup: 'Первый' });
    expect(trading.getSnapshot().pendingTradeReviews).toHaveLength(1);
    await expect(
      trading.saveTradeReview(reviews[0].trade.id, { setup: 'Первый' }),
    ).rejects.toThrow('Сначала сохраните характеристики предыдущей сделки');
    await trading.saveTradeReview(reviews[1].trade.id, { setup: 'Второй' });
    expect(closedTrades.map((trade) => trade.characteristics?.setup)).toEqual([
      'Первый',
      'Второй',
    ]);
    expect(balanceEntries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(stagedReviews).toHaveLength(0);
    simulation.destroy();
  });

  test('keeps trade markers unchanged across thousands of idle seconds and appends executions immutably', async () => {
    const { simulation, trading, session, instrument, history } =
      createHarness();
    await simulation.start();
    simulation.pause();
    trading.openMarket('buy', 0.01);
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    await approveReviews(trading);
    const checkpoint = await trading.checkpoint();
    trading.detach();
    simulation.destroy();

    const frames = new Frames();
    const source = {
      async loadSeconds(
        _dataset: string,
        from: number,
        through: number,
        after?: number,
        limit = 800,
      ) {
        const start = after === undefined ? from : after + 1;
        const count = Math.min(limit, through - start + 1);
        return {
          candles: Array.from({ length: count }, (_, index) => ({
            time: start + index,
            open: 100,
            high: 100,
            low: 99,
            close: 100,
          })),
          hasMore: start + count <= through,
          hasNewer: false,
        };
      },
    };
    const replay = SimulationEngine.restore(
      instrument.datasetId,
      { startTime: 100, endTime: 10_000, speed: 10_000 },
      source,
      { time: 100, speed: 10_000, delivered: true, budget: 0 },
      frames,
    );
    const restored = TradingEngine.restore(
      session,
      instrument,
      history,
      checkpoint,
    );
    restored.connect(replay);
    await replay.start();
    replay.play();
    const before = restored.getSnapshot();
    const markers = before.markers;
    for (let batch = 0; batch < 4; batch++) {
      frames.advance(80);
      await flush();
      expect(restored.getSnapshot().markers).toBe(markers);
    }
    expect(restored.getSnapshot().currentTime).toBeGreaterThan(3000);
    restored.placeLimit('buy', 99.5, 0.02);
    frames.advance(80);
    await flush();
    const openedMarkers = restored.getSnapshot().markers;
    expect(openedMarkers).not.toBe(markers);
    expect(openedMarkers).toHaveLength(markers.length + 1);
    expect(openedMarkers.slice(0, -1)).toEqual(checkpoint.snapshot.markers);
    expect(openedMarkers.at(-1)).toMatchObject({ phase: 'open', price: 99.5 });
    expect(before.markers).toBe(markers);
    expect(markers).toEqual(checkpoint.snapshot.markers);
    frames.advance(80);
    await flush();
    expect(restored.getSnapshot().markers).toBe(openedMarkers);
    restored.closeOrder(restored.getSnapshot().orders[0].id);
    expect(restored.getSnapshot().markers).not.toBe(openedMarkers);
    expect(restored.getSnapshot().markers.at(-1)?.phase).toBe('close');
    expect(openedMarkers).toHaveLength(3);
    await approveReviews(restored);
    await restored.checkpoint();
    restored.detach();
    replay.destroy();
  });

  test('calculates signed profit in points and scales by lot size', () => {
    expect(calculateProfit('buy', 100, 100.7, 0.1, 5, 0.02)).toBeCloseTo(70);
    expect(calculateProfit('sell', 100, 100.7, 0.1, 5, 0.01)).toBeCloseTo(-35);
  });

  test('requires protection levels on the correct side of a position', () => {
    expect(() =>
      validateProtection('buy', 100, { stopLoss: 99, takeProfit: 101 }),
    ).not.toThrow();
    expect(() =>
      validateProtection('sell', 100, { stopLoss: 101, takeProfit: 99 }),
    ).not.toThrow();
    expect(() => validateProtection('buy', 100, { stopLoss: 101 })).toThrow(
      'Стоп-лосс BUY должен быть ниже цены входа.',
    );
  });

  test('fills limits and triggers protection when a candle wick crosses the level', async () => {
    const { frames, simulation, trading, closedTrades, balanceEntries } =
      createHarness();
    simulation.start();
    await flush();
    expect(trading.getSnapshot().currentPrice).toBe(100);

    trading.placeLimit('buy', 99.5, 0.02);
    frames.advance(1000);
    const order = trading.getSnapshot().orders[0];
    expect(order.status).toBe('open');
    expect(order.price).toBe(99.5);
    expect(trading.getSnapshot().markers[0]).toMatchObject({
      orderId: order.id,
      phase: 'open',
      price: 99.5,
      time: 101,
      side: 'buy',
    });

    trading.setProtection(order.id, 'takeProfit', 100.2);
    frames.advance(1000);
    await flush();
    await trading.finish(102);
    await approveReviews(trading);

    expect(trading.getSnapshot().orders).toHaveLength(0);
    expect(closedTrades).toHaveLength(1);
    expect(closedTrades[0]).toMatchObject({
      entryPrice: 99.5,
      exitPrice: 100.2,
      openedAt: 101,
      closedAt: 102,
      closeReason: 'take-profit',
    });
    expect(closedTrades[0]?.profit).toBeCloseTo(70);
    expect(trading.getSnapshot().balance).toBeCloseTo(1070);
    expect(balanceEntries[0]).toMatchObject({
      sessionId: 'session-1',
      kind: 'trade',
      sequence: 1,
      time: 102,
      tradeId: closedTrades[0].id,
    });
    expect(balanceEntries[0].change).toBeCloseTo(70);
    expect(balanceEntries[0].balance).toBeCloseTo(1070);
    expect(trading.getSnapshot().markers).toHaveLength(2);
    expect(trading.getSnapshot().markers[1]).toMatchObject({
      orderId: order.id,
      phase: 'close',
      price: 100.2,
      time: 102,
      side: 'buy',
    });
    simulation.destroy();
  });

  test('records a manually closed market position in session history', async () => {
    const { simulation, trading, closedTrades } = createHarness();
    simulation.start();
    await flush();
    trading.openMarket('sell', 0.03);

    const order = trading.getSnapshot().orders[0];
    expect(order?.status).toBe('open');
    if (!order) throw new Error('Expected the market order to open.');
    trading.closeOrder(order.id);
    await trading.finish(100);
    await approveReviews(trading);

    expect(closedTrades).toHaveLength(1);
    expect(closedTrades[0]).toMatchObject({
      side: 'sell',
      volume: 0.03,
      entryPrice: 100,
      exitPrice: 100,
      closeReason: 'manual',
    });
    expect(trading.getSnapshot().markers).toHaveLength(2);
    expect(trading.getSnapshot().markers.map(({ phase }) => phase)).toEqual([
      'open',
      'close',
    ]);
    expect(trading.getSnapshot().markers[0]?.orderId).toBe(
      trading.getSnapshot().markers[1]?.orderId,
    );
    simulation.destroy();
  });

  test('changes balance only on closing and keeps sessions independent', async () => {
    const {
      frames,
      simulation,
      trading,
      candles,
      balanceEntries,
      closedTrades,
    } = createHarness();
    const other = createHarness(2500, 'session-2');
    candles[1] = { time: 101, open: 100, high: 100.4, low: 100, close: 100.4 };
    simulation.start();
    await flush();
    trading.placeLimit('buy', 99, 0.01);
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    expect(trading.getSnapshot().balance).toBe(1000);
    expect(balanceEntries).toHaveLength(0);

    trading.openMarket('buy', 0.02);
    frames.advance(1000);
    await flush();
    expect(trading.getSnapshot().orders[0].profit).toBeCloseTo(40);
    expect(trading.getSnapshot().balance).toBe(1000);
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    expect(trading.getSnapshot().balance).toBeCloseTo(1040);
    expect(other.trading.getSnapshot().balance).toBe(2500);
    await trading.finish(101);
    await approveReviews(trading);
    expect(balanceEntries).toHaveLength(1);
    expect(balanceEntries[0]).toMatchObject({
      sessionId: 'session-1',
      sequence: 1,
      time: 101,
      tradeId: closedTrades[0].id,
    });
    expect(balanceEntries[0].change).toBeCloseTo(40);
    expect(balanceEntries[0].balance).toBeCloseTo(1040);
    simulation.destroy();
    other.simulation.destroy();
  });

  test('subtracts the realized loss when stop loss closes a position', async () => {
    const { frames, simulation, trading, balanceEntries } = createHarness();
    simulation.start();
    await flush();
    trading.openMarket('buy', 0.01);
    trading.setProtection(trading.getSnapshot().orders[0].id, 'stopLoss', 99.5);
    frames.advance(1000);
    await flush();
    expect(trading.getSnapshot().balance).toBeCloseTo(975);
    await trading.finish(101);
    await approveReviews(trading);
    expect(balanceEntries[0].change).toBeCloseTo(-25);
    expect(balanceEntries[0].balance).toBeCloseTo(975);
    simulation.destroy();
  });

  test('records ordered balance changes for positions closed together at simulation end', async () => {
    const {
      frames,
      simulation,
      trading,
      candles,
      closedTrades,
      balanceEntries,
    } = createHarness();
    candles[1] = { time: 101, open: 100, high: 100.4, low: 100, close: 100.4 };
    simulation.start();
    await flush();
    trading.openMarket('buy', 0.01);
    trading.openMarket('sell', 0.02);
    frames.advance(1000);
    await flush();
    await trading.finish(101);
    await trading.finish(101);
    await approveReviews(trading);
    expect(closedTrades).toHaveLength(2);
    expect(balanceEntries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(balanceEntries.map((entry) => entry.time)).toEqual([101, 101]);
    expect(balanceEntries[0].balance).toBeCloseTo(1020);
    expect(balanceEntries[1].balance).toBeCloseTo(980);
    expect(trading.getSnapshot().balance).toBeCloseTo(980);
    simulation.destroy();
  });

  test.each([0, -100, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid initial balance %s',
    (balance) => {
      expect(() => createHarness(balance)).toThrow(
        'Баланс демосчёта должен быть числом больше нуля.',
      );
    },
  );

  test('retries a failed balance entry before saving the next closed trade', async () => {
    const {
      frames,
      simulation,
      trading,
      candles,
      history,
      closedTrades,
      balanceEntries,
    } = createHarness();
    const saveClosedTrade = history.saveClosedTrade;
    const attempts: number[] = [];
    history.saveClosedTrade = async (trade, entry) => {
      attempts.push(entry.sequence);
      if (attempts.length === 1) throw new Error('Storage is unavailable.');
      await saveClosedTrade(trade, entry);
    };
    candles[1] = { time: 101, open: 100, high: 100.4, low: 100, close: 100.4 };
    simulation.start();
    await flush();
    trading.openMarket('buy', 0.01);
    trading.openMarket('sell', 0.02);
    frames.advance(1000);
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    const first = trading.getSnapshot().pendingTradeReviews?.[0];
    if (!first) throw new Error('Expected a trade awaiting review.');
    await expect(trading.saveTradeReview(first.trade.id, {})).rejects.toThrow(
      'Storage is unavailable.',
    );
    expect(closedTrades).toHaveLength(0);
    expect(trading.getSnapshot().pendingTradeReviews).toHaveLength(1);
    expect(() =>
      trading.closeOrder(trading.getSnapshot().orders[0].id),
    ).toThrow('Сначала заполните характеристики');

    await approveReviews(trading);
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    await approveReviews(trading);
    await trading.finish(101);
    expect(attempts).toEqual([1, 1, 2]);
    expect(closedTrades).toHaveLength(2);
    expect(balanceEntries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(balanceEntries[0].balance).toBeCloseTo(1020);
    expect(balanceEntries[1].balance).toBeCloseTo(980);
    expect(trading.getSnapshot().balance).toBeCloseTo(980);
    expect(trading.getSnapshot().error).toBeUndefined();
    simulation.destroy();
  });

  test('retries staging on repeated finish without duplicating reviews or ending before a failed write', async () => {
    const { simulation, trading, history, closedTrades, balanceEntries } =
      createHarness();
    const stageClosedTrade = history.stageClosedTrade;
    let unavailable = true;
    let attempts = 0;
    let finished = 0;
    history.stageClosedTrade = async (review) => {
      attempts++;
      if (unavailable) throw new Error('Storage is unavailable.');
      await stageClosedTrade(review);
    };
    history.finishSession = async () => {
      finished++;
    };
    simulation.start();
    await flush();
    trading.openMarket('buy', 0.01);
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    await trading.finish(100);
    expect(trading.getSnapshot().error).toContain('Storage is unavailable.');
    expect(closedTrades).toHaveLength(0);
    expect(finished).toBe(0);
    const failedAttempts = attempts;
    await flush();
    expect(attempts).toBe(failedAttempts);

    unavailable = false;
    await trading.finish(100);
    await trading.finish(100);
    expect(trading.getSnapshot().pendingTradeReviews).toHaveLength(1);
    expect(closedTrades).toHaveLength(0);
    await approveReviews(trading);
    expect(closedTrades).toHaveLength(1);
    expect(balanceEntries).toHaveLength(1);
    expect(finished).toBe(1);
    expect(trading.getSnapshot().error).toBeUndefined();
    simulation.destroy();
  });

  test.each(['buy', 'sell'] as const)(
    'moves %s limit protection with the entry price, preserving both distances',
    async (side) => {
      const { simulation, trading } = createHarness();
      simulation.start();
      await flush();
      const direction = side === 'buy' ? 1 : -1;
      const entry = side === 'buy' ? 99 : 101;
      trading.placeLimit(side, entry, 0.01);
      const order = trading.getSnapshot().orders[0];
      trading.editOrder(order.id, {
        stopLoss: entry - direction * 0.7,
        takeProfit: entry + direction * 1.2,
      });

      for (const offset of [0.6, -0.2, 1.4]) {
        const price = entry - direction * offset;
        const previous = trading.getSnapshot();
        trading.editOrder(order.id, { price });
        const current = trading.getSnapshot();
        const moved = current.orders[0];
        expect(current).not.toBe(previous);
        expect(moved.status).toBe('pending');
        expect(moved.price).toBe(price);
        expect(moved.stopLoss).toBeCloseTo(price - direction * 0.7, 10);
        expect(moved.takeProfit).toBeCloseTo(price + direction * 1.2, 10);
      }
      simulation.destroy();
    },
  );

  test('preserves unset levels and accepts explicit protection values when editing a limit', async () => {
    const { simulation, trading } = createHarness();
    simulation.start();
    await flush();
    trading.placeLimit('buy', 99, 0.01);
    const order = trading.getSnapshot().orders[0];
    trading.editOrder(order.id, { price: 98 });
    expect(trading.getSnapshot().orders[0]).toMatchObject({
      stopLoss: undefined,
      takeProfit: undefined,
    });
    trading.setProtection(order.id, 'stopLoss', 97);
    trading.editOrder(order.id, { price: 97 });
    expect(trading.getSnapshot().orders[0]).toMatchObject({
      stopLoss: 96,
      takeProfit: undefined,
    });
    trading.editOrder(order.id, {
      price: 96,
      stopLoss: undefined,
      takeProfit: 98,
    });
    expect(trading.getSnapshot().orders[0]).toMatchObject({
      price: 96,
      stopLoss: undefined,
      takeProfit: 98,
    });
    trading.editOrder(order.id, { price: 95 });
    expect(trading.getSnapshot().orders[0]).toMatchObject({
      stopLoss: undefined,
      takeProfit: 97,
    });
    simulation.destroy();
  });

  test('changes a pending order volume without changing entry or protection', async () => {
    const { simulation, trading } = createHarness();
    simulation.start();
    await flush();
    trading.placeLimit('buy', 99.5, 0.01);
    const order = trading.getSnapshot().orders[0];
    trading.editOrder(order.id, { stopLoss: 98, takeProfit: 102 });

    trading.editOrder(order.id, { volume: 0.04 });

    expect(trading.getSnapshot().orders[0]).toMatchObject({
      id: order.id,
      status: 'pending',
      price: 99.5,
      volume: 0.04,
      stopLoss: 98,
      takeProfit: 102,
      profit: 0,
    });
    expect(trading.getSnapshot().markers).toHaveLength(0);
    expect(trading.getSnapshot().balance).toBe(1000);
    simulation.destroy();
  });

  test('fills an edited volume and uses it for open profit and closed history', async () => {
    const { simulation, trading, frames, closedTrades } = createHarness();
    simulation.start();
    await flush();
    trading.placeLimit('buy', 99.5, 0.01);
    const order = trading.getSnapshot().orders[0];
    trading.editOrder(order.id, { volume: 0.03 });

    frames.advance(1000);

    expect(trading.getSnapshot().orders[0]).toMatchObject({
      status: 'open',
      volume: 0.03,
      price: 99.5,
    });
    expect(trading.getSnapshot().orders[0].profit).toBeCloseTo(75);
    trading.closeOrder(order.id);
    await approveReviews(trading);
    expect(closedTrades).toHaveLength(1);
    expect(closedTrades[0].volume).toBe(0.03);
    expect(closedTrades[0].profit).toBeCloseTo(75);
    expect(trading.getSnapshot().balance).toBeCloseTo(1075);
    simulation.destroy();
  });

  test('uses the new volume when an entry edit fills a limit immediately', async () => {
    const { simulation, trading } = createHarness();
    simulation.start();
    await flush();
    trading.placeLimit('buy', 99, 0.01);
    const order = trading.getSnapshot().orders[0];

    trading.editOrder(order.id, { price: 100.5, volume: 0.03 });

    expect(trading.getSnapshot().orders[0]).toMatchObject({
      status: 'open',
      price: 100.5,
      volume: 0.03,
    });
    expect(trading.getSnapshot().orders[0].profit).toBeCloseTo(-75);
    simulation.destroy();
  });

  test.each([0, -0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid edited volume %s before changing any order field',
    async (volume) => {
      const { simulation, trading } = createHarness();
      simulation.start();
      await flush();
      trading.placeLimit('buy', 99, 0.01);
      const original = trading.getSnapshot();
      const order = structuredClone(original.orders[0]);

      expect(() =>
        trading.editOrder(order.id, {
          volume,
          price: 98,
          stopLoss: 97,
          takeProfit: 101,
        }),
      ).toThrow('Объём должен быть числом больше нуля.');

      expect(trading.getSnapshot()).toBe(original);
      expect(trading.getSnapshot().orders[0]).toEqual(order);
      simulation.destroy();
    },
  );

  test('blocks changing an open volume while allowing protection edits with its unchanged volume', async () => {
    const { simulation, trading } = createHarness();
    simulation.start();
    await flush();
    trading.openMarket('buy', 0.01);
    const original = trading.getSnapshot();
    const order = structuredClone(original.orders[0]);

    expect(() =>
      trading.editOrder(order.id, {
        volume: 0.02,
        stopLoss: 99,
        takeProfit: 101,
      }),
    ).toThrow('Нельзя изменить объём уже открытой сделки.');
    expect(trading.getSnapshot()).toBe(original);
    expect(trading.getSnapshot().orders[0]).toEqual(order);

    trading.editOrder(order.id, {
      volume: 0.01,
      stopLoss: 99,
      takeProfit: 101,
    });
    expect(trading.getSnapshot().orders[0]).toMatchObject({
      status: 'open',
      volume: 0.01,
      stopLoss: 99,
      takeProfit: 101,
    });
    trading.setProtection(order.id, 'takeProfit', 102);
    expect(trading.getSnapshot().orders[0].takeProfit).toBe(102);
    simulation.destroy();
  });

  test('fills a moved limit with its shifted protection when it crosses the current price', async () => {
    const { simulation, trading } = createHarness();
    simulation.start();
    await flush();
    trading.placeLimit('buy', 99, 0.01);
    const order = trading.getSnapshot().orders[0];
    trading.editOrder(order.id, { stopLoss: 98, takeProfit: 101 });
    trading.editOrder(order.id, { price: 100.5 });
    expect(trading.getSnapshot().orders[0]).toMatchObject({
      status: 'open',
      price: 100.5,
      stopLoss: 99.5,
      takeProfit: 102.5,
    });
    expect(trading.getSnapshot().markers[0]).toMatchObject({
      orderId: order.id,
      phase: 'open',
      price: 100.5,
    });
    simulation.destroy();
  });

  test('checkpoint flushes realized trades and restore keeps open orders, protection, markers and counters', async () => {
    const {
      frames,
      simulation,
      trading,
      candles,
      history,
      session,
      instrument,
      source,
      closedTrades,
      balanceEntries,
    } = createHarness();
    let finishedSessions = 0;
    history.finishSession = async () => {
      finishedSessions++;
    };
    candles[1] = { time: 101, open: 100, high: 100.4, low: 100, close: 100.4 };
    simulation.start();
    await flush();
    trading.openMarket('buy', 0.01);
    frames.advance(1000);
    simulation.pause();
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    await approveReviews(trading);
    trading.openMarket('buy', 0.02);
    const marketId = trading.getSnapshot().orders[0].id;
    trading.editOrder(marketId, { stopLoss: 99, takeProfit: 102 });
    trading.placeLimit('buy', 98, 0.03);
    const limitId = trading.getSnapshot().orders[1].id;
    trading.editOrder(limitId, { stopLoss: 97, takeProfit: 101 });

    const checkpoint = await trading.checkpoint();
    const replayCheckpoint = simulation.exportCheckpoint();
    expect(closedTrades).toHaveLength(1);
    expect(balanceEntries).toHaveLength(1);
    expect(checkpoint).toMatchObject({
      pointValuePer001: 5,
      nextTicket: 4,
      balanceSequence: 1,
    });
    expect(checkpoint.snapshot.balance).toBeCloseTo(1020);
    expect(checkpoint.snapshot.orders).toHaveLength(2);
    expect(checkpoint.snapshot.markers).toHaveLength(3);
    trading.detach();
    simulation.destroy();
    expect(finishedSessions).toBe(0);
    expect(trading.getSnapshot().finished).toBe(false);

    const restored = TradingEngine.restore(
      session,
      instrument,
      history,
      checkpoint,
    );
    expect(restored.getSnapshot()).toEqual(checkpoint.snapshot);
    expect(restored.getSnapshot()).not.toBe(checkpoint.snapshot);
    expect(restored.getSnapshot().orders[0]).not.toBe(
      checkpoint.snapshot.orders[0],
    );
    expect(restored.getSnapshot().markers[0]).not.toBe(
      checkpoint.snapshot.markers[0],
    );
    checkpoint.snapshot.orders[0].stopLoss = 1;
    checkpoint.snapshot.markers[0].price = 1;
    expect(restored.getSnapshot().orders[0]).toMatchObject({
      id: marketId,
      stopLoss: 99,
      takeProfit: 102,
    });
    expect(restored.getSnapshot().orders[1]).toMatchObject({
      id: limitId,
      status: 'pending',
      stopLoss: 97,
      takeProfit: 101,
    });
    expect(restored.getSnapshot().markers[0].price).toBe(100);

    const resumedSimulation = SimulationEngine.restore(
      instrument.datasetId,
      simulation.settings,
      source,
      replayCheckpoint,
      frames,
    );
    restored.connect(resumedSimulation);
    resumedSimulation.start();
    await flush();
    expect(restored.getSnapshot().currentTime).toBe(101);
    expect(restored.getSnapshot().orders).toHaveLength(2);
    expect(closedTrades).toHaveLength(1);
    restored.openMarket('sell', 0.01);
    const newOrder = restored.getSnapshot().orders[2];
    expect(newOrder.ticket).toBe(4);
    restored.closeOrder(marketId);
    await approveReviews(restored);
    restored.closeOrder(newOrder.id);
    await approveReviews(restored);
    const nextCheckpoint = await restored.checkpoint();
    expect(nextCheckpoint).toMatchObject({
      pointValuePer001: 5,
      nextTicket: 5,
      balanceSequence: 3,
    });
    expect(closedTrades).toHaveLength(3);
    expect(new Set(closedTrades.map((trade) => trade.id)).size).toBe(3);
    expect(balanceEntries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    await restored.finish(101);
    expect(finishedSessions).toBe(1);
    expect(closedTrades).toHaveLength(3);
    resumedSimulation.destroy();
  });

  test('detach removes replay listeners without closing positions or ending the session', async () => {
    const { frames, simulation, trading, history, closedTrades } =
      createHarness();
    let finishedSessions = 0;
    history.finishSession = async () => {
      finishedSessions++;
    };
    simulation.start();
    await flush();
    trading.openMarket('buy', 0.01);
    trading.detach();
    frames.advance(2000);
    await flush();
    expect(simulation.getSnapshot().status).toBe('finished');
    expect(trading.getSnapshot()).toMatchObject({
      currentTime: 100,
      finished: false,
    });
    expect(trading.getSnapshot().orders).toHaveLength(1);
    expect(closedTrades).toHaveLength(0);
    expect(finishedSessions).toBe(0);
    simulation.destroy();
  });

  test('failed review save retains the trade and blocks checkpoints until a successful retry', async () => {
    const { simulation, trading, history, closedTrades, balanceEntries } =
      createHarness();
    const save = history.saveClosedTrade;
    let unavailable = true;
    history.saveClosedTrade = async (trade, entry) => {
      if (unavailable) throw new Error('Storage is unavailable.');
      await save(trade, entry);
    };
    simulation.start();
    await flush();
    simulation.pause();
    trading.openMarket('buy', 0.01);
    trading.closeOrder(trading.getSnapshot().orders[0].id);
    const review = trading.getSnapshot().pendingTradeReviews?.[0];
    if (!review) throw new Error('Expected a trade awaiting review.');
    await expect(trading.checkpoint()).rejects.toThrow(
      'Сначала заполните характеристики',
    );
    await expect(
      trading.saveTradeReview(review.trade.id, { setup: 'Breakout' }),
    ).rejects.toThrow('Storage is unavailable.');
    expect(trading.getSnapshot().pendingTradeReviews?.[0]).toBe(review);
    expect(closedTrades).toHaveLength(0);
    expect(trading.getSnapshot().finished).toBe(false);
    unavailable = false;
    await trading.saveTradeReview(review.trade.id, { setup: 'Breakout' });
    const checkpoint = await trading.checkpoint();
    await trading.checkpoint();
    expect(checkpoint.balanceSequence).toBe(1);
    expect(closedTrades).toHaveLength(1);
    expect(balanceEntries.map((entry) => entry.sequence)).toEqual([1]);
    expect(closedTrades[0].characteristics).toEqual({ setup: 'Breakout' });
    expect(trading.getSnapshot().error).toBeUndefined();
    trading.detach();
    simulation.destroy();
  });
});
