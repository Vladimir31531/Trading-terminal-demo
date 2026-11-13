import { describe, expect, test } from 'bun:test';
import { analyzeTradingSession } from '../src/domain/session-analytics';
import {
  recalculateTradeDeletion,
  removeClosedTradeFromSnapshot,
} from '../src/domain/trade-deletion';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradeMarker,
  TradingSession,
  TradingSnapshot,
} from '../src/domain/trading';

const session: TradingSession = {
  id: 'session',
  instrumentId: 'gold',
  datasetId: 'csv',
  ticker: 'XAU/USD',
  startedAt: 100_000,
  simulationStartTime: 100,
  simulationEndTime: 400,
  tradeCount: 3,
  totalProfit: 80,
  initialBalance: 1000,
  balance: 1080,
};

function trade(ticket: number, profit: number): ClosedTrade {
  return {
    id: `trade-${ticket}`,
    orderId: `order-${ticket}`,
    sessionId: session.id,
    instrumentId: session.instrumentId,
    ticker: session.ticker,
    ticket,
    side: 'buy',
    kind: 'market',
    volume: 0.01,
    entryPrice: 100,
    exitPrice: 100 + profit,
    openedAt: 100 + ticket * 10,
    closedAt: 200 + ticket * 10,
    profit,
    closeReason: 'manual',
    characteristics: { setup: 'Breakout' },
  };
}

const trades = [trade(1, 100), trade(2, -40), trade(3, 20)];
const initial: BalanceHistoryEntry = {
  id: 'initial',
  sessionId: session.id,
  sequence: 0,
  time: 100,
  kind: 'initial',
  change: 1000,
  balance: 1000,
};

function entriesFor(
  closedTrades: readonly ClosedTrade[],
): BalanceHistoryEntry[] {
  let balance = initial.balance;
  return [
    initial,
    ...closedTrades.map((item, index) => {
      balance += item.profit;
      return {
        id: `balance-${item.ticket}`,
        sessionId: item.sessionId,
        sequence: index + 1,
        time: item.closedAt,
        kind: 'trade' as const,
        change: item.profit,
        balance,
        tradeId: item.id,
      };
    }),
  ];
}

function markersFor(
  closedTrade: ClosedTrade,
  orderId = closedTrade.orderId ?? 'legacy',
): TradeMarker[] {
  return [
    {
      id: `${orderId}-open`,
      orderId,
      phase: 'open',
      time: closedTrade.openedAt,
      price: closedTrade.entryPrice,
      side: closedTrade.side,
    },
    {
      id: `${orderId}-close`,
      orderId,
      phase: 'close',
      time: closedTrade.closedAt,
      price: closedTrade.exitPrice,
      side: closedTrade.side,
    },
  ];
}

function snapshot(
  markers: TradeMarker[] = trades.flatMap((item) => markersFor(item)),
): TradingSnapshot {
  return {
    sessionId: session.id,
    currentTime: 300,
    currentPrice: 110,
    balance: 1080,
    orders: [
      {
        id: 'still-open',
        ticket: 4,
        instrumentId: session.instrumentId,
        ticker: session.ticker,
        side: 'sell',
        kind: 'market',
        status: 'open',
        volume: 0.02,
        price: 110,
        currentPrice: 110,
        profit: 0,
        placedAt: 250,
        openedAt: 250,
      },
    ],
    markers,
    finished: false,
  };
}

describe('removing a trade from session balances and analytics', () => {
  test.each([
    {
      index: 0,
      profit: -20,
      balance: 980,
      balances: [1000, 960, 980],
      sequences: [0, 2, 3],
    },
    {
      index: 1,
      profit: 120,
      balance: 1120,
      balances: [1000, 1100, 1120],
      sequences: [0, 1, 3],
    },
    {
      index: 2,
      profit: 60,
      balance: 1060,
      balances: [1000, 1100, 1060],
      sequences: [0, 1, 2],
    },
  ])(
    'recalculates a removed winner, loser or last trade: $index',
    ({ index, profit, balance, balances, sequences }) => {
      const entries = entriesFor(trades);
      const original = structuredClone({ session, trades, entries });
      const removed = trades[index];
      const remaining = trades.filter((item) => item.id !== removed.id);
      const result = recalculateTradeDeletion(
        session,
        removed,
        remaining,
        entries,
      );
      expect(result.session).toMatchObject({
        tradeCount: 2,
        totalProfit: profit,
        balance,
      });
      expect(result.balanceHistory.map((item) => item.balance)).toEqual([
        ...balances,
      ]);
      expect(result.balanceHistory.map((item) => item.sequence)).toEqual([
        ...sequences,
      ]);
      expect(
        result.balanceHistory.some((item) => item.tradeId === removed.id),
      ).toBe(false);
      const analytics = analyzeTradingSession(
        result.session,
        remaining,
        result.balanceHistory,
      );
      expect(analytics.totalTrades).toBe(2);
      expect(analytics.netProfit).toBe(profit);
      expect(analytics.endingBalance).toBe(balance);
      expect(analytics.balanceSeries.map((item) => item.balance)).toEqual([
        ...balances,
      ]);
      expect({ session, trades, entries }).toEqual(original);
    },
  );

  test('removing the only trade restores the initial balance without inventing replacement records', () => {
    const only = trades[0];
    const result = recalculateTradeDeletion(
      { ...session, tradeCount: 1, totalProfit: 100, balance: 1100 },
      only,
      [],
      entriesFor([only]),
    );
    expect(result.session).toMatchObject({
      tradeCount: 0,
      totalProfit: 0,
      balance: 1000,
    });
    expect(result.balanceHistory).toEqual([initial]);
    expect(result.balanceHistory[0]).toBe(initial);
  });

  test('removing a zero-result trade changes only the count and its record', () => {
    const zero = trade(4, 0);
    const entries = entriesFor([...trades, zero]);
    const result = recalculateTradeDeletion(
      { ...session, tradeCount: 4 },
      zero,
      trades,
      entries,
    );
    expect(result.session).toMatchObject({
      tradeCount: 3,
      totalProfit: 80,
      balance: 1080,
    });
    expect(result.balanceHistory).toEqual(entries.slice(0, -1));
  });

  test('legacy sessions keep an unknown balance and absent balance history', () => {
    const legacy = {
      ...session,
      initialBalance: undefined,
      balance: undefined,
    };
    const remaining = trades.slice(1);
    const result = recalculateTradeDeletion(legacy, trades[0], remaining, []);
    expect(result.session).toMatchObject({ tradeCount: 2, totalProfit: -20 });
    expect(result.session.balance).toBeUndefined();
    expect(result.session.initialBalance).toBeUndefined();
    expect(result.balanceHistory).toEqual([]);
    expect(
      recalculateTradeDeletion(
        { ...legacy, balance: 1080 },
        trades[0],
        remaining,
        [],
      ).session.balance,
    ).toBe(980);
  });

  test('ignores other sessions and retains remaining balance record identities and order', () => {
    const foreignTrade = { ...trades[1], id: 'foreign', sessionId: 'other' };
    const foreignEntry = {
      ...entriesFor(trades)[2],
      id: 'foreign-entry',
      sessionId: 'other',
    };
    const entries = [foreignEntry, ...entriesFor(trades).reverse()];
    const result = recalculateTradeDeletion(
      session,
      trades[0],
      [foreignTrade, ...trades.slice(1)],
      entries,
    );
    expect(result.session).toMatchObject({
      tradeCount: 2,
      totalProfit: -20,
      balance: 980,
    });
    expect(result.balanceHistory[0]).toBe(foreignEntry);
    expect(result.balanceHistory.map((item) => item.id)).toEqual([
      'foreign-entry',
      'balance-3',
      'balance-2',
      'initial',
    ]);
    expect(result.balanceHistory[1]).toMatchObject({
      sequence: 3,
      change: 20,
      time: trades[2].closedAt,
    });
  });

  test('rejects deletion in a different session before changing any state', () => {
    expect(() =>
      recalculateTradeDeletion(
        { ...session, id: 'other' },
        trades[0],
        trades,
        [],
      ),
    ).toThrow('Сделка не принадлежит этой торговой сессии.');
    expect(() =>
      removeClosedTradeFromSnapshot(
        { ...snapshot(), sessionId: 'other' },
        trades[0],
      ),
    ).toThrow('Сделка не принадлежит этой торговой сессии.');
  });
});

describe('removing trade arrows and persisted simulation traces', () => {
  test('uses exact order identity without affecting equal-time trades or active orders', () => {
    const sameExecution = {
      ...trades[0],
      id: 'another-trade',
      orderId: 'another-order',
    };
    const state = snapshot([
      ...markersFor(trades[0]),
      ...markersFor(sameExecution),
    ]);
    const before = structuredClone(state);
    const result = removeClosedTradeFromSnapshot(state, trades[0]);
    expect(result.balance).toBe(980);
    expect(result.markers).toEqual(markersFor(sameExecution));
    expect(result.orders).toBe(state.orders);
    expect(state).toEqual(before);
    expect(result.currentTime).toBe(state.currentTime);
  });

  test('legacy identical simultaneous executions remove only one complete matching pair', () => {
    const legacy = { ...trades[0], orderId: undefined };
    const unrelated = { ...legacy, side: 'sell' as const };
    const second = markersFor(legacy, 'legacy-second');
    const otherSide = markersFor(unrelated, 'legacy-sell');
    const state = snapshot([
      ...markersFor(legacy, 'legacy-first'),
      ...second,
      ...otherSide,
    ]);
    const result = removeClosedTradeFromSnapshot(state, legacy);
    expect(result.markers).toEqual([...second, ...otherSide]);
    expect(state.markers).toHaveLength(6);
  });

  test('does not erase a partial or mismatched legacy pair', () => {
    const legacy = { ...trades[0], orderId: undefined };
    const partial = markersFor(legacy, 'partial')[0];
    const wrongExit = markersFor({ ...legacy, exitPrice: 999 }, 'wrong-exit');
    const rightPair = markersFor(legacy, 'correct');
    const state = snapshot([partial, ...wrongExit, ...rightPair]);
    expect(removeClosedTradeFromSnapshot(state, legacy).markers).toEqual([
      partial,
      ...wrongExit,
    ]);
    const unmatched = snapshot([partial, ...wrongExit]);
    expect(removeClosedTradeFromSnapshot(unmatched, legacy).markers).toEqual(
      unmatched.markers,
    );
  });

  test('rebases pending balances and removes a target pending copy without mutating review data', () => {
    const pending = trade(5, 25);
    const state = snapshot();
    state.balance = 1105;
    state.pendingTradeReviews = [
      { trade: trades[0], balanceEntry: entriesFor(trades)[1] },
      {
        trade: pending,
        balanceEntry: {
          id: 'pending-balance',
          sessionId: session.id,
          sequence: 5,
          time: pending.closedAt,
          kind: 'trade',
          change: pending.profit,
          balance: 1105,
          tradeId: pending.id,
        },
      },
    ];
    const before = structuredClone(state);
    const result = removeClosedTradeFromSnapshot(state, trades[0]);
    expect(result.balance).toBe(1005);
    expect(result.pendingTradeReviews).toHaveLength(1);
    expect(result.pendingTradeReviews?.[0]).toMatchObject({
      trade: pending,
      balanceEntry: {
        id: 'pending-balance',
        sequence: 5,
        change: 25,
        balance: 1005,
      },
    });
    expect(state).toEqual(before);
  });

  test('works for a completed checkpoint and preserves absent legacy pending data', () => {
    const state = { ...snapshot(), finished: true };
    const result = removeClosedTradeFromSnapshot(state, trades[1]);
    expect(result.finished).toBe(true);
    expect(result.balance).toBe(1120);
    expect(result.markers).toHaveLength(4);
    expect(Object.hasOwn(result, 'pendingTradeReviews')).toBe(false);
  });
});
