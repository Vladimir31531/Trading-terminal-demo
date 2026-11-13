import { describe, expect, test } from 'bun:test';
import { analyzeTradingSession } from '../src/domain/session-analytics';
import {
  analyzeCustomTradingSession,
  type CharacteristicMultiFilters,
  filterTrades,
} from '../src/domain/trade-filters';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from '../src/domain/trading';

const start = Date.parse('2026-01-05T00:00:00Z') / 1000;
const session: TradingSession = {
  id: 'session',
  instrumentId: 'instrument',
  datasetId: 'dataset',
  ticker: 'TEST',
  startedAt: start * 1000,
  initialBalance: 1000,
  balance: 1040,
  tradeCount: 5,
  totalProfit: 40,
  simulationStartTime: start,
  simulationEndTime: start + 7 * 86400,
};

function trade(
  ticket: number,
  changes: Partial<ClosedTrade> = {},
): ClosedTrade {
  return {
    id: `trade-${ticket}`,
    sessionId: session.id,
    instrumentId: session.instrumentId,
    ticker: session.ticker,
    ticket,
    side: 'buy',
    kind: 'market',
    volume: 0.01,
    entryPrice: 100,
    exitPrice: 101,
    openedAt: start + ticket * 100,
    closedAt: start + ticket * 100 + 60,
    profit: 10,
    closeReason: 'manual',
    ...changes,
  };
}

function historyFor(trades: readonly ClosedTrade[]): BalanceHistoryEntry[] {
  let balance = session.initialBalance ?? 0;
  return trades.map((item, index) => {
    balance += item.profit;
    return {
      id: `balance-${index}`,
      sessionId: session.id,
      sequence: index + 1,
      time: item.closedAt,
      kind: 'trade',
      change: item.profit,
      balance,
      tradeId: item.id,
    };
  });
}

describe('trade history filters', () => {
  test('uses inclusive opening and closing ranges without changing the input order', () => {
    const trades = [trade(3), trade(2), trade(1)];
    expect(
      filterTrades(trades, {
        openedAt: { from: start + 100, to: start + 200 },
      }).map((item) => item.ticket),
    ).toEqual([2, 1]);
    expect(
      filterTrades(trades, {
        closedAt: { from: start + 160, to: start + 260 },
      }).map((item) => item.ticket),
    ).toEqual([2, 1]);
    expect(
      filterTrades(trades, {
        openedAt: { from: start + 101 },
        closedAt: { to: start + 260 },
      }).map((item) => item.ticket),
    ).toEqual([2]);
    expect(
      filterTrades(trades, {
        openedAt: { from: start + 201, to: start + 200 },
      }),
    ).toEqual([]);
    expect(trades.map((item) => item.ticket)).toEqual([3, 2, 1]);
  });

  test('compares full UTC seconds at midnight and supports zero timestamp bounds', () => {
    const midnight = Date.parse('2026-02-01T00:00:00Z') / 1000;
    const trades = [
      trade(1, { openedAt: midnight - 1, closedAt: midnight }),
      trade(2, { openedAt: midnight, closedAt: midnight + 1 }),
      trade(3, { openedAt: 0, closedAt: 1 }),
    ];
    expect(
      filterTrades(trades, { openedAt: { from: midnight, to: midnight } }).map(
        (item) => item.ticket,
      ),
    ).toEqual([2]);
    expect(
      filterTrades(trades, { closedAt: { to: midnight } }).map(
        (item) => item.ticket,
      ),
    ).toEqual([1, 3]);
    expect(
      filterTrades(trades, { openedAt: { from: 0, to: 0 } }).map(
        (item) => item.ticket,
      ),
    ).toEqual([3]);
  });

  test('intersects type, close reason and every selected characteristic', () => {
    const trades = [
      trade(1, {
        characteristics: { setup: 'Breakout', direction: 'Trend' },
        closeReason: 'take-profit',
      }),
      trade(2, {
        characteristics: { setup: 'Breakout', direction: 'Countertrend' },
        closeReason: 'take-profit',
      }),
      trade(3, {
        characteristics: { setup: 'Breakout', direction: 'Trend' },
        closeReason: 'stop-loss',
      }),
      trade(4, {
        characteristics: { setup: 'Breakout', direction: 'Trend' },
        closeReason: 'take-profit',
        kind: 'limit',
      }),
      trade(5, {
        characteristics: { setup: 'Breakout', direction: 'Trend' },
        closeReason: 'take-profit',
        side: 'sell',
      }),
    ];
    expect(
      filterTrades(trades, {
        type: 'buy market',
        closeReason: 'take-profit',
        characteristics: { setup: 'Breakout', direction: 'Trend' },
      }).map((item) => item.ticket),
    ).toEqual([1]);
    expect(
      filterTrades(trades, { type: 'sell market' }).map((item) => item.ticket),
    ).toEqual([5]);
  });

  test('keeps missing legacy values distinct from literal option labels', () => {
    const trades = [
      trade(1),
      trade(2, { characteristics: {} }),
      trade(3, { characteristics: { setup: '-' } }),
      trade(4, { characteristics: { setup: 'all' } }),
      trade(5, { characteristics: { setup: 'missing' } }),
    ];
    expect(
      filterTrades(trades, { characteristics: { setup: null } }).map(
        (item) => item.ticket,
      ),
    ).toEqual([1, 2]);
    for (const [value, ticket] of [
      ['-', 3],
      ['all', 4],
      ['missing', 5],
    ] as const)
      expect(
        filterTrades(trades, { characteristics: { setup: value } }).map(
          (item) => item.ticket,
        ),
      ).toEqual([ticket]);
    expect(
      filterTrades(trades, { characteristics: { setup: undefined } }),
    ).toEqual(trades);
  });

  test('does not rewrite saved trades or mutate filter objects', () => {
    const trades = [
      trade(1, { characteristics: { setup: 'Breakout' } }),
      trade(2),
    ];
    const filters = {
      characteristics: { setup: 'Breakout' },
      openedAt: { from: start },
    };
    const originals = structuredClone({ trades, filters });
    const selected = filterTrades(trades, filters);
    expect(selected).not.toBe(trades);
    expect(selected[0]).toBe(trades[0]);
    expect({ trades, filters }).toEqual(originals);
  });
});

describe('custom trade characteristic analytics', () => {
  const trades = [
    trade(1, { profit: 100, characteristics: { setup: 'A' } }),
    trade(2, { profit: -50, characteristics: { setup: 'B' } }),
    trade(3, { profit: 20, characteristics: { setup: 'A' } }),
    trade(4, { profit: -30, characteristics: { setup: 'B' } }),
    trade(5, { profit: 0, characteristics: { setup: 'A' } }),
  ];
  const history = historyFor(trades);

  test('reconstructs selected balances and growth without importing excluded P/L', () => {
    const selected = analyzeCustomTradingSession(session, trades, history, {
      setup: 'A',
    });
    expect(selected).toMatchObject({
      totalTrades: 3,
      grossProfit: 120,
      grossLoss: 0,
      netProfit: 120,
      wins: 2,
      losses: 0,
      breakeven: 1,
      endingBalance: 1120,
      maxDrawdown: 0,
      tradesPerWeek: 3,
    });
    expect(selected.balanceSeries.map((point) => point.balance)).toEqual([
      1000, 1100, 1120, 1120,
    ]);
    expect(selected.balanceSeries.at(-1)?.growthPercent).toBe(12);
    expect(selected.monthly[0].total).toBe(120);
    const losses = analyzeCustomTradingSession(session, trades, history, {
      setup: 'B',
    });
    expect(losses).toMatchObject({
      netProfit: -80,
      endingBalance: 920,
      maxDrawdown: 80,
      maxDrawdownPercent: 8,
      wins: 0,
      losses: 2,
      tradesPerWeek: 2,
    });
    expect(history.map((entry) => entry.balance)).toEqual([
      1100, 1050, 1070, 1040, 1040,
    ]);
  });

  test('preserves saved execution sequence for simultaneous filtered closes', () => {
    const sameTime = start + 1000;
    const executions = [
      trade(99, {
        profit: 100,
        closedAt: sameTime,
        characteristics: { setup: 'A' },
      }),
      trade(2, {
        profit: 1000,
        closedAt: sameTime,
        characteristics: { setup: 'B' },
      }),
      trade(1, {
        profit: -200,
        closedAt: sameTime,
        characteristics: { setup: 'A' },
      }),
    ];
    const selected = analyzeCustomTradingSession(
      session,
      executions.slice().reverse(),
      historyFor(executions),
      { setup: 'A' },
    );
    expect(selected.trades.map((item) => item.ticket)).toEqual([99, 1]);
    expect(selected.balanceSeries.map((point) => point.balance)).toEqual([
      1000, 1100, 900,
    ]);
    expect(selected.maxDrawdown).toBe(200);
  });

  test('handles empty and single selections, and all-values matches the full calculation', () => {
    const empty = analyzeCustomTradingSession(session, trades, history, {
      setup: 'unknown',
    });
    expect(empty).toMatchObject({
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      netProfit: 0,
      endingBalance: 1000,
      maxDrawdown: 0,
      tradesPerWeek: 0,
    });
    expect(empty.sharpeRatio).toBeUndefined();
    expect(empty.averageHoldSeconds).toBeUndefined();
    const one = analyzeCustomTradingSession(session, [trades[0]], history, {
      setup: 'A',
    });
    expect(one.totalTrades).toBe(1);
    expect(one.sharpeRatio).toBeUndefined();
    expect(one.endingBalance).toBe(1100);
    expect(analyzeCustomTradingSession(session, trades, history, {})).toEqual(
      analyzeTradingSession(session, trades, history),
    );
  });

  test('legacy sessions retain the full comparison period and unavailable balance', () => {
    const legacy = {
      ...session,
      initialBalance: undefined,
      balance: undefined,
      simulationStartTime: undefined,
      simulationEndTime: undefined,
    };
    const executions = [
      trade(1, {
        openedAt: 100,
        closedAt: 200,
        characteristics: { setup: 'A' },
      }),
      trade(2, { openedAt: 500, closedAt: 1000 }),
    ];
    const selected = analyzeCustomTradingSession(legacy, executions, [], {
      setup: 'A',
    });
    expect(selected.balanceSeries[0].time).toBe(100);
    expect(selected.endingBalance).toBeUndefined();
    expect(selected.maxDrawdownPercent).toBeUndefined();
    expect(selected.tradesPerWeek).toBeCloseTo(604800 / 900);
    expect(selected.balanceSeries.at(-1)?.cumulativeProfit).toBe(10);
    expect(
      analyzeCustomTradingSession(legacy, executions, [], {
        setup: null,
      }).trades.map((item) => item.ticket),
    ).toEqual([2]);
  });

  test('ignores foreign or invalid executions while preserving all source records', () => {
    const source = [
      ...trades,
      trade(6, {
        profit: 99999,
        sessionId: 'other',
        characteristics: { setup: 'A' },
      }),
      trade(7, { profit: Number.NaN, characteristics: { setup: 'A' } }),
    ];
    const original = structuredClone(source);
    expect(
      analyzeCustomTradingSession(session, source, history, { setup: 'A' })
        .netProfit,
    ).toBe(120);
    expect(source).toEqual(original);
  });
});

describe('Custom characteristic multiselects', () => {
  const trades = [
    trade(1, {
      profit: 100,
      characteristics: { setup: 'A', direction: 'Trend' },
    }),
    trade(2, {
      profit: -50,
      characteristics: { setup: 'B', direction: 'Trend' },
    }),
    trade(3, {
      profit: 20,
      characteristics: { setup: 'C', direction: 'Countertrend' },
    }),
    trade(4, { profit: -10 }),
    trade(5, {
      profit: 5,
      characteristics: { setup: '-', direction: 'Trend' },
    }),
    trade(6, {
      profit: 0,
      characteristics: { setup: 'A', direction: 'Countertrend' },
    }),
  ];
  const history = historyFor(trades);

  test('combines selected values of one characteristic through OR', () => {
    const selected = analyzeCustomTradingSession(session, trades, history, {
      setup: ['A', 'B'],
    });
    expect(selected.trades.map((item) => item.ticket)).toEqual([1, 2, 6]);
    expect(selected).toMatchObject({
      totalTrades: 3,
      wins: 1,
      losses: 1,
      breakeven: 1,
      netProfit: 50,
      endingBalance: 1050,
    });
  });

  test('combines different characteristic multiselects through AND', () => {
    const selected = analyzeCustomTradingSession(session, trades, history, {
      setup: ['A', 'B'],
      direction: ['Trend'],
    });
    expect(selected.trades.map((item) => item.ticket)).toEqual([1, 2]);
    expect(
      analyzeCustomTradingSession(session, trades, history, {
        setup: ['A', 'C'],
        direction: ['Countertrend', 'Sideways'],
      }).trades.map((item) => item.ticket),
    ).toEqual([3, 6]);
  });

  test('selecting none in any characteristic yields an empty sample', () => {
    const selected = analyzeCustomTradingSession(session, trades, history, {
      setup: ['A', 'B', null],
      direction: [],
    });
    expect(selected).toMatchObject({
      totalTrades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      netProfit: 0,
      endingBalance: 1000,
      maxDrawdown: 0,
    });
    expect(selected.balanceSeries).toHaveLength(1);
    expect(selected.sharpeRatio).toBeUndefined();
  });

  test('all values retains trades with missing or legacy characteristic values', () => {
    const filters: CharacteristicMultiFilters = {
      setup: undefined,
      direction: undefined,
    };
    const all = analyzeCustomTradingSession(session, trades, history, filters);
    expect(all.trades).toEqual(trades);
    expect(all).toEqual(
      analyzeCustomTradingSession(session, trades, history, {}),
    );
    expect(all).toEqual(analyzeTradingSession(session, trades, history));
  });

  test('a mixed selection can include missing values and named values without conflating a literal dash', () => {
    const selected = analyzeCustomTradingSession(session, trades, history, {
      setup: [null, 'A'],
    });
    expect(selected.trades.map((item) => item.ticket)).toEqual([1, 4, 6]);
    expect(selected.endingBalance).toBe(1090);
    expect(
      analyzeCustomTradingSession(session, trades, history, {
        setup: ['-'],
      }).trades.map((item) => item.ticket),
    ).toEqual([5]);
    expect(
      analyzeCustomTradingSession(session, trades, history, {
        setup: [null, '-'],
      }).trades.map((item) => item.ticket),
    ).toEqual([4, 5]);
  });

  test('literal option labels never act as all or missing sentinels', () => {
    const labelled = [
      trade(1),
      trade(2, { characteristics: { setup: 'all' } }),
      trade(3, { characteristics: { setup: 'missing' } }),
      trade(4, { characteristics: { setup: 'Все значения' } }),
    ];
    const selected = analyzeCustomTradingSession(session, labelled, [], {
      setup: ['all', 'missing'],
    });
    expect(selected.trades.map((item) => item.ticket)).toEqual([2, 3]);
  });

  test('recalculates balance and drawdown from only the selected executions', () => {
    const executions = [
      trade(1, { profit: 100, characteristics: { setup: 'A' } }),
      trade(2, { profit: 1000, characteristics: { setup: 'Excluded' } }),
      trade(3, { profit: -40, characteristics: { setup: 'B' } }),
      trade(4, { profit: 10, characteristics: { setup: 'A' } }),
    ];
    const balances = historyFor(executions);
    const selected = analyzeCustomTradingSession(
      session,
      executions,
      balances,
      { setup: ['A', 'B'] },
    );
    expect(selected).toMatchObject({
      totalTrades: 3,
      netProfit: 70,
      endingBalance: 1070,
      maxDrawdown: 40,
    });
    expect(selected.balanceSeries.map((point) => point.balance)).toEqual([
      1000, 1100, 1060, 1070,
    ]);
    expect(selected.monthly[0].total).toBe(70);
    expect(balances.at(-1)?.balance).toBe(2070);
  });

  test('duplicate choices do not duplicate executions and read-only inputs are not changed', () => {
    const choices = Object.freeze(['A', 'A', null] as const);
    const filters: CharacteristicMultiFilters = Object.freeze({
      setup: choices,
    });
    const original = structuredClone({ trades, history, filters });
    const selected = analyzeCustomTradingSession(
      session,
      trades,
      history,
      filters,
    );
    expect(selected.trades.map((item) => item.ticket)).toEqual([1, 4, 6]);
    expect({ trades, history, filters }).toEqual(original);
    expect(choices).toEqual(['A', 'A', null]);
  });
});
