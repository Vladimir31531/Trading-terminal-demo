import { describe, expect, test } from 'bun:test';
import { analyzeTradingSession } from '../src/domain/session-analytics';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from '../src/domain/trading';

const seconds = (iso: string) => Date.parse(iso) / 1000;
const start = seconds('2026-01-05T00:00:00Z');
const session: TradingSession = {
  id: 'session',
  instrumentId: 'instrument',
  datasetId: 'dataset',
  ticker: 'TEST',
  startedAt: Date.parse('2026-10-26T15:00:00Z'),
  initialBalance: 1000,
  balance: 1000,
  simulationStartTime: start,
  simulationEndTime: start + 7 * 86_400,
  tradeCount: 0,
  totalProfit: 0,
};

function trade(
  profit: number,
  ticket = 1,
  changes: Partial<ClosedTrade> = {},
): ClosedTrade {
  return {
    id: `trade-${ticket}`,
    sessionId: session.id,
    ticket,
    instrumentId: session.instrumentId,
    ticker: session.ticker,
    side: 'buy',
    kind: 'market',
    volume: 0.01,
    entryPrice: 100,
    exitPrice: 100 + profit,
    openedAt: start + ticket * 100 - 60,
    closedAt: start + ticket * 100,
    profit,
    closeReason: 'manual',
    ...changes,
  };
}

describe('trading session analytics', () => {
  test('aggregates real closed results and preserves the chronological balance curve', () => {
    const trades = [
      trade(100, 1),
      trade(-40, 2),
      trade(0, 3),
      trade(60, 4),
      trade(-20, 5),
    ];
    const original = [trades[4], trades[0], trades[3], trades[1], trades[2]];
    const analytics = analyzeTradingSession(session, original);
    expect(analytics).toMatchObject({
      grossProfit: 160,
      grossLoss: 60,
      netProfit: 100,
      totalTrades: 5,
      wins: 2,
      losses: 2,
      breakeven: 1,
      initialBalance: 1000,
      endingBalance: 1100,
      maxDrawdown: 40,
      averageHoldSeconds: 60,
      tradesPerWeek: 5,
      swaps: 0,
      commissions: 0,
      dividends: 0,
    });
    expect(analytics.profitFactor).toBeCloseTo(160 / 60);
    expect(analytics.recoveryFactor).toBeCloseTo(2.5);
    expect(analytics.maxDrawdownPercent).toBeCloseTo((40 / 1100) * 100);
    expect(analytics.balanceSeries.map((point) => point.balance)).toEqual([
      1000, 1100, 1060, 1060, 1120, 1100,
    ]);
    expect(analytics.balanceSeries.at(-1)?.growthPercent).toBeCloseTo(10);
    expect(analytics.trades.map((item) => item.ticket)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(original.map((item) => item.ticket)).toEqual([5, 1, 4, 2, 3]);
    expect(analytics.sources[0]).toMatchObject({
      label: 'Manual',
      profit: 160,
      loss: 60,
      net: 100,
      trades: 5,
    });
    expect(analytics.sources.slice(1).every((item) => item.trades === 0)).toBe(
      true,
    );
    expect(analytics.equitySeries).toBeUndefined();
    expect(analytics.maxDepositLoad).toBeUndefined();
  });

  test('computes maximum monetary and relative drawdowns independently', () => {
    const analytics = analyzeTradingSession(session, [
      trade(1000, 1),
      trade(-500, 2),
      trade(5000, 3),
      trade(-1000, 4),
    ]);
    expect(analytics.maxDrawdown).toBe(1000);
    expect(analytics.maxDrawdownPercent).toBe(25);
    expect(analytics.recoveryFactor).toBe(4.5);
  });

  test('orders the balance by closure rather than by the time positions opened', () => {
    const earlierOpen = trade(10, 1, {
      openedAt: start,
      closedAt: start + 100,
    });
    const earlierClose = trade(-5, 2, {
      openedAt: start + 10,
      closedAt: start + 50,
    });
    const analytics = analyzeTradingSession(session, [
      earlierOpen,
      earlierClose,
    ]);
    expect(analytics.trades.map((item) => item.ticket)).toEqual([2, 1]);
    expect(analytics.balanceSeries.map((point) => point.balance)).toEqual([
      1000, 995, 1005,
    ]);
    expect(analytics.averageHoldSeconds).toBe(70);
  });

  test('uses persisted sequence for simultaneous closes, falling back to ticket order', () => {
    const close = start + 100;
    const win = trade(100, 99, { closedAt: close, openedAt: start });
    const loss = trade(-200, 1, { closedAt: close, openedAt: start });
    const history: BalanceHistoryEntry[] = [
      {
        id: 'balance-2',
        sessionId: session.id,
        sequence: 2,
        time: close,
        kind: 'trade',
        change: -200,
        balance: 900,
        tradeId: loss.id,
      },
      {
        id: 'balance-1',
        sessionId: session.id,
        sequence: 1,
        time: close,
        kind: 'trade',
        change: 100,
        balance: 1100,
        tradeId: win.id,
      },
    ];
    const analytics = analyzeTradingSession(session, [loss, win], history);
    expect(analytics.trades.map((item) => item.id)).toEqual([win.id, loss.id]);
    expect(analytics.balanceSeries.map((point) => point.balance)).toEqual([
      1000, 1100, 900,
    ]);
    expect(
      analyzeTradingSession(session, [win, loss]).trades.map(
        (item) => item.ticket,
      ),
    ).toEqual([1, 99]);
    expect(history.map((item) => item.sequence)).toEqual([2, 1]);
  });

  test('legacy sessions expose cumulative P/L without inventing an account balance', () => {
    const legacy = {
      ...session,
      initialBalance: undefined,
      balance: undefined,
      simulationStartTime: undefined,
      simulationEndTime: undefined,
    };
    const analytics = analyzeTradingSession(legacy, [
      trade(100, 1),
      trade(-200, 2),
    ]);
    expect(analytics.initialBalance).toBeUndefined();
    expect(analytics.endingBalance).toBeUndefined();
    expect(analytics.maxDrawdownPercent).toBeUndefined();
    expect(analytics.maxDrawdown).toBe(200);
    expect(
      analytics.balanceSeries.map((point) => point.cumulativeProfit),
    ).toEqual([0, 100, -100]);
    expect(
      analytics.balanceSeries.every(
        (point) =>
          point.balance === undefined && point.growthPercent === undefined,
      ),
    ).toBe(true);
    expect(analytics.balanceSeries[0].time).toBe(start + 40);
    expect(analytics.averageHoldSeconds).toBe(60);
  });

  test('groups closes into UTC dates, months, years and weekdays, including inactive days', () => {
    const first = seconds('2025-12-31T23:59:59Z');
    const january = seconds('2026-01-31T23:59:59Z');
    const february = seconds('2026-02-01T00:00:00Z');
    const analytics = analyzeTradingSession(
      { ...session, simulationStartTime: first, simulationEndTime: february },
      [
        trade(10, 1, { openedAt: first - 60, closedAt: first }),
        trade(30, 2, { openedAt: january - 60, closedAt: january }),
        trade(-5, 3, { openedAt: february - 60, closedAt: february }),
      ],
    );
    expect(analytics.monthly.map((item) => [item.year, item.total])).toEqual([
      [2025, 10],
      [2026, 25],
    ]);
    expect(analytics.monthly[0].months[11]).toBe(10);
    expect(analytics.monthly[1].months[0]).toBe(30);
    expect(analytics.monthly[1].months[1]).toBe(-5);
    expect(
      analytics.daily.find(
        (day) => day.time === seconds('2026-01-01T00:00:00Z'),
      )?.trades,
    ).toBe(0);
    expect(analytics.daily.at(-1)).toMatchObject({
      time: february,
      profit: 0,
      loss: 5,
      net: -5,
      wins: 0,
      losses: 1,
    });
    expect(analytics.weekday[2]).toMatchObject({ label: 'Wed', profit: 10 });
    expect(analytics.weekday[5]).toMatchObject({ label: 'Sat', profit: 30 });
    expect(analytics.weekday[6]).toMatchObject({ label: 'Sun', loss: 5 });
  });

  test('keeps non-annualized per-trade Sharpe separate from undefined zero-risk ratios', () => {
    const analytics = analyzeTradingSession(session, [
      trade(10, 1),
      trade(30, 2),
    ]);
    expect(analytics.sharpeRatio).toBeCloseTo(Math.SQRT2);
    expect(analytics.profitFactor).toBeUndefined();
    expect(analytics.recoveryFactor).toBeUndefined();
    expect(
      analyzeTradingSession(session, [trade(10, 1), trade(10, 2)]).sharpeRatio,
    ).toBeUndefined();
    expect(
      analyzeTradingSession(session, [trade(10, 1)]).sharpeRatio,
    ).toBeUndefined();
    expect(
      analyzeTradingSession(session, [trade(10, 1), trade(-10, 2)]).sharpeRatio,
    ).toBe(0);
    expect(analyzeTradingSession(session, [trade(-10, 1)]).profitFactor).toBe(
      0,
    );
  });

  test('uses the actual short replay duration for trade frequency, without a minimum week', () => {
    const analytics = analyzeTradingSession(
      { ...session, simulationEndTime: start + 3600 },
      [
        trade(10, 1, { openedAt: start + 10, closedAt: start + 20 }),
        trade(-5, 2, { openedAt: start + 20, closedAt: start + 50 }),
      ],
    );
    expect(analytics.tradesPerWeek).toBe(336);
    expect(analytics.averageHoldSeconds).toBe(20);
  });

  test('empty and flat sessions produce finite zero totals and no unavailable ratios', () => {
    const analytics = analyzeTradingSession(session, []);
    expect(analytics).toMatchObject({
      grossProfit: 0,
      grossLoss: 0,
      netProfit: 0,
      totalTrades: 0,
      endingBalance: 1000,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      tradesPerWeek: 0,
    });
    expect(analytics.balanceSeries).toEqual([
      { time: start, balance: 1000, cumulativeProfit: 0, growthPercent: 0 },
    ]);
    expect(analytics.averageHoldSeconds).toBeUndefined();
    expect(analytics.profitFactor).toBeUndefined();
    expect(analytics.recoveryFactor).toBeUndefined();
    expect(analytics.sharpeRatio).toBeUndefined();
    const flat = analyzeTradingSession(session, [trade(0)]);
    expect(flat.breakeven).toBe(1);
    expect(flat.sharpeRatio).toBeUndefined();
    expect(
      analyzeTradingSession({ ...session, simulationEndTime: start }, [])
        .tradesPerWeek,
    ).toBeUndefined();
  });

  test('does not mix trades or balances from another session or propagate non-finite results', () => {
    const analytics = analyzeTradingSession(session, [
      trade(10, 1),
      trade(999, 2, { sessionId: 'other' }),
      trade(Number.NaN, 3),
    ]);
    expect(analytics.totalTrades).toBe(1);
    expect(analytics.netProfit).toBe(10);
    expect(analytics.endingBalance).toBe(1010);
  });
});
