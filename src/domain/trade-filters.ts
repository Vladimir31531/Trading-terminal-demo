import {
  analyzeTradingSession,
  type SessionAnalytics,
} from './session-analytics';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from './trading';

export interface TradeDateRange {
  from?: number;
  to?: number;
}

/** Undefined means all values; null means no value was recorded. */
export type CharacteristicFilters = Readonly<
  Record<string, string | null | undefined>
>;

export interface TradeHistoryFilters {
  openedAt?: TradeDateRange;
  closedAt?: TradeDateRange;
  type?: string;
  closeReason?: ClosedTrade['closeReason'];
  characteristics?: CharacteristicFilters;
}

function withinRange(time: number, range?: TradeDateRange): boolean {
  return (
    (range?.from === undefined || time >= range.from) &&
    (range?.to === undefined || time <= range.to)
  );
}

/** Date endpoints are inclusive UTC seconds; every active filter must match. */
export function filterTrades(
  trades: readonly ClosedTrade[],
  filters: TradeHistoryFilters,
): ClosedTrade[] {
  const characteristicFilters = Object.entries(filters.characteristics ?? {});
  return trades.filter(
    (trade) =>
      withinRange(trade.openedAt, filters.openedAt) &&
      withinRange(trade.closedAt, filters.closedAt) &&
      (filters.type === undefined ||
        `${trade.side} ${trade.kind}` === filters.type) &&
      (filters.closeReason === undefined ||
        trade.closeReason === filters.closeReason) &&
      characteristicFilters.every(
        ([id, value]) =>
          value === undefined ||
          (trade.characteristics?.[id] ?? null) === value,
      ),
  );
}

/** Compare selected executions over the original session period and starting balance. */
export function analyzeCustomTradingSession(
  session: TradingSession,
  trades: readonly ClosedTrade[],
  balanceHistory: readonly BalanceHistoryEntry[],
  filters: CharacteristicFilters,
): SessionAnalytics {
  const validTrades = trades.filter(
    (trade) =>
      trade.sessionId === session.id &&
      Number.isFinite(trade.profit) &&
      Number.isFinite(trade.openedAt) &&
      Number.isFinite(trade.closedAt),
  );
  const initialTime = balanceHistory.find(
    (entry) =>
      entry.sessionId === session.id &&
      entry.kind === 'initial' &&
      Number.isFinite(entry.time),
  )?.time;
  const startTime = validTrades.reduce<number | undefined>(
    (first, trade) =>
      first === undefined ? trade.openedAt : Math.min(first, trade.openedAt),
    undefined,
  );
  const endTime = validTrades.reduce<number | undefined>(
    (last, trade) =>
      last === undefined ? trade.closedAt : Math.max(last, trade.closedAt),
    undefined,
  );
  const periodSession = {
    ...session,
    simulationStartTime: Number.isFinite(session.simulationStartTime)
      ? session.simulationStartTime
      : (initialTime ?? startTime),
    simulationEndTime: Number.isFinite(session.simulationEndTime)
      ? session.simulationEndTime
      : endTime,
  };
  return analyzeTradingSession(
    periodSession,
    filterTrades(validTrades, { characteristics: filters }),
    balanceHistory,
    { balanceSource: 'trades' },
  );
}
