import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
  TradingSnapshot,
} from './trading';

/** Remove one closed execution from an active or suspended session state. */
export function removeClosedTradeFromSnapshot(
  snapshot: TradingSnapshot,
  trade: ClosedTrade,
): TradingSnapshot {
  if (snapshot.sessionId !== trade.sessionId)
    throw new Error('Сделка не принадлежит этой торговой сессии.');
  const orderId =
    trade.orderId ??
    snapshot.markers.find(
      (marker) =>
        marker.phase === 'open' &&
        marker.time === trade.openedAt &&
        marker.price === trade.entryPrice &&
        marker.side === trade.side &&
        snapshot.markers.some(
          (close) =>
            close.orderId === marker.orderId &&
            close.phase === 'close' &&
            close.time === trade.closedAt &&
            close.price === trade.exitPrice &&
            close.side === trade.side,
        ),
    )?.orderId;

  return {
    ...snapshot,
    balance: snapshot.balance - trade.profit,
    markers: snapshot.markers.filter((marker) => marker.orderId !== orderId),
    ...(snapshot.pendingTradeReviews && {
      pendingTradeReviews: snapshot.pendingTradeReviews
        .filter((review) => review.trade.id !== trade.id)
        .map((review) =>
          review.trade.sessionId === trade.sessionId
            ? {
                ...review,
                balanceEntry: {
                  ...review.balanceEntry,
                  balance: review.balanceEntry.balance - trade.profit,
                },
              }
            : review,
        ),
    }),
  };
}

/** Preserve execution sequence and record identity while removing its realized P/L. */
export function recalculateTradeDeletion(
  session: TradingSession,
  removed: ClosedTrade,
  remainingTrades: readonly ClosedTrade[],
  entries: readonly BalanceHistoryEntry[],
): { session: TradingSession; balanceHistory: BalanceHistoryEntry[] } {
  if (session.id !== removed.sessionId)
    throw new Error('Сделка не принадлежит этой торговой сессии.');
  const trades = remainingTrades.filter(
    (trade) => trade.sessionId === session.id && trade.id !== removed.id,
  );
  const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);
  const removedEntry = entries.find(
    (entry) => entry.sessionId === session.id && entry.tradeId === removed.id,
  );
  return {
    session: {
      ...session,
      tradeCount: trades.length,
      totalProfit,
      balance:
        session.initialBalance !== undefined
          ? session.initialBalance + totalProfit
          : session.balance === undefined
            ? undefined
            : session.balance - removed.profit,
    },
    balanceHistory: entries
      .filter(
        (entry) =>
          entry.sessionId !== session.id || entry.tradeId !== removed.id,
      )
      .map((entry) =>
        removedEntry &&
        entry.sessionId === session.id &&
        entry.sequence > removedEntry.sequence
          ? { ...entry, balance: entry.balance - removed.profit }
          : entry,
      ),
  };
}
