import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from './trading';

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = DAY_SECONDS * 7;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface ProfitLossTotals {
  profit: number;
  /** Loss is a positive magnitude. */
  loss: number;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
}

export interface DailyProfitLoss extends ProfitLossTotals {
  /** Start of the UTC day, in seconds. */
  time: number;
}

export interface ProfitLossBreakdown extends ProfitLossTotals {
  label: string;
}

export interface MonthlyProfitLoss {
  year: number;
  /** January through December. */
  months: number[];
  total: number;
}

export interface SessionBalancePoint {
  time: number;
  balance?: number;
  cumulativeProfit: number;
  growthPercent?: number;
}

export interface SessionAnalytics {
  /** Ordered by closing time, persisted sequence, then ticket. */
  trades: ClosedTrade[];
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  swaps: number;
  dividends: number;
  commissions: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  profitFactor?: number;
  recoveryFactor?: number;
  /** Mean per-trade P/L divided by sample SD; zero risk-free rate, not annualized. */
  sharpeRatio?: number;
  maxDrawdown: number;
  /** Maximum relative balance drawdown, independently of maximum monetary drawdown. */
  maxDrawdownPercent?: number;
  averageHoldSeconds?: number;
  tradesPerWeek?: number;
  initialBalance?: number;
  endingBalance?: number;
  /** Closed trades cannot reconstruct historical floating P/L or margin. */
  equitySeries: undefined;
  maxDepositLoad: undefined;
  balanceSeries: SessionBalancePoint[];
  daily: DailyProfitLoss[];
  monthly: MonthlyProfitLoss[];
  weekday: ProfitLossBreakdown[];
  sources: ProfitLossBreakdown[];
}

function emptyTotals(): ProfitLossTotals {
  return {
    profit: 0,
    loss: 0,
    net: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
  };
}

function addTrade(totals: ProfitLossTotals, profit: number): void {
  totals.net += profit;
  totals.trades++;
  if (profit > 0) {
    totals.profit += profit;
    totals.wins++;
  } else if (profit < 0) {
    totals.loss -= profit;
    totals.losses++;
  } else {
    totals.breakeven++;
  }
}

function ratio(numerator: number, denominator: number): number | undefined {
  const value = numerator / denominator;
  return denominator > 0 && Number.isFinite(value) ? value : undefined;
}

function sharpeRatio(
  trades: readonly ClosedTrade[],
  net: number,
): number | undefined {
  if (trades.length < 2) return undefined;
  const mean = net / trades.length;
  const variance =
    trades.reduce((sum, trade) => sum + (trade.profit - mean) ** 2, 0) /
    (trades.length - 1);
  return ratio(mean, Math.sqrt(variance));
}

function validTime(time: number | undefined): time is number {
  return time !== undefined && Number.isFinite(time);
}

/** All replay timestamps and date groups use UTC seconds, never wall-clock session dates. */
export function analyzeTradingSession(
  session: TradingSession,
  closedTrades: readonly ClosedTrade[],
  balanceHistory: readonly BalanceHistoryEntry[] = [],
): SessionAnalytics {
  const historyByTrade = new Map(
    balanceHistory
      .filter(
        (entry) =>
          entry.sessionId === session.id &&
          entry.tradeId &&
          Number.isFinite(entry.sequence) &&
          Number.isFinite(entry.balance),
      )
      .map((entry) => [entry.tradeId, entry]),
  );
  const trades = closedTrades
    .filter(
      (trade) =>
        trade.sessionId === session.id &&
        Number.isFinite(trade.profit) &&
        validTime(trade.openedAt) &&
        validTime(trade.closedAt),
    )
    .slice()
    .sort(
      (left, right) =>
        left.closedAt - right.closedAt ||
        (historyByTrade.get(left.id)?.sequence ?? Number.MAX_SAFE_INTEGER) -
          (historyByTrade.get(right.id)?.sequence ?? Number.MAX_SAFE_INTEGER) ||
        left.ticket - right.ticket,
    );
  const totals = emptyTotals();
  const initialBalance =
    session.initialBalance !== undefined &&
    Number.isFinite(session.initialBalance) &&
    session.initialBalance > 0
      ? session.initialBalance
      : undefined;
  const initialEntry = balanceHistory.find(
    (entry) =>
      entry.sessionId === session.id &&
      entry.kind === 'initial' &&
      validTime(entry.time),
  );
  const firstOpenTime = trades.reduce<number | undefined>(
    (first, trade) =>
      first === undefined ? trade.openedAt : Math.min(first, trade.openedAt),
    undefined,
  );
  const startTime = validTime(session.simulationStartTime)
    ? session.simulationStartTime
    : (initialEntry?.time ?? firstOpenTime);
  const endTime = validTime(session.simulationEndTime)
    ? session.simulationEndTime
    : trades.at(-1)?.closedAt;
  const balanceSeries: SessionBalancePoint[] = [];
  if (startTime !== undefined) {
    balanceSeries.push({
      time: startTime,
      balance: initialBalance,
      cumulativeProfit: 0,
      growthPercent: initialBalance === undefined ? undefined : 0,
    });
  }
  const dailyByTime = new Map<number, DailyProfitLoss>();
  const weekday = WEEKDAYS.map((label) => ({ label, ...emptyTotals() }));
  const sources = ['Manual', 'Robot', 'Signals'].map((label) => ({
    label,
    ...emptyTotals(),
  }));
  let holdSeconds = 0;
  let balance = initialBalance;
  let peak = initialBalance ?? 0;
  let maxDrawdown = 0;
  let maxDrawdownPercent = initialBalance === undefined ? undefined : 0;
  for (const trade of trades) {
    addTrade(totals, trade.profit);
    holdSeconds += Math.max(0, trade.closedAt - trade.openedAt);
    if (balance !== undefined) {
      balance = historyByTrade.get(trade.id)?.balance ?? balance + trade.profit;
    }
    const value = balance ?? totals.net;
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak - value);
    if (maxDrawdownPercent !== undefined && peak > 0) {
      maxDrawdownPercent = Math.max(
        maxDrawdownPercent,
        ((peak - value) / peak) * 100,
      );
    }
    balanceSeries.push({
      time: trade.closedAt,
      balance,
      cumulativeProfit: totals.net,
      growthPercent:
        initialBalance === undefined || balance === undefined
          ? undefined
          : ((balance - initialBalance) / initialBalance) * 100,
    });
    const dayTime = Math.floor(trade.closedAt / DAY_SECONDS) * DAY_SECONDS;
    let day = dailyByTime.get(dayTime);
    if (!day) {
      day = { time: dayTime, ...emptyTotals() };
      dailyByTime.set(dayTime, day);
    }
    addTrade(day, trade.profit);
    addTrade(
      weekday[(new Date(dayTime * 1000).getUTCDay() + 6) % 7],
      trade.profit,
    );
    addTrade(sources[0], trade.profit);
  }
  // Include inactive UTC days so the money/deals chart returns to zero between trades.
  if (startTime !== undefined && endTime !== undefined) {
    for (
      let time = Math.floor(startTime / DAY_SECONDS) * DAY_SECONDS;
      time <= endTime;
      time += DAY_SECONDS
    ) {
      if (!dailyByTime.has(time))
        dailyByTime.set(time, { time, ...emptyTotals() });
    }
  }
  const daily = [...dailyByTime.values()].sort(
    (left, right) => left.time - right.time,
  );
  const monthlyByYear = new Map<number, MonthlyProfitLoss>();
  for (const day of daily) {
    const date = new Date(day.time * 1000);
    const year = date.getUTCFullYear();
    let monthly = monthlyByYear.get(year);
    if (!monthly) {
      monthly = { year, months: Array<number>(12).fill(0), total: 0 };
      monthlyByYear.set(year, monthly);
    }
    monthly.months[date.getUTCMonth()] += day.net;
    monthly.total += day.net;
  }
  const duration =
    startTime !== undefined && endTime !== undefined ? endTime - startTime : 0;
  return {
    trades,
    grossProfit: totals.profit,
    grossLoss: totals.loss,
    netProfit: totals.net,
    swaps: 0,
    dividends: 0,
    commissions: 0,
    totalTrades: totals.trades,
    wins: totals.wins,
    losses: totals.losses,
    breakeven: totals.breakeven,
    profitFactor: ratio(totals.profit, totals.loss),
    recoveryFactor: ratio(totals.net, maxDrawdown),
    sharpeRatio: sharpeRatio(trades, totals.net),
    maxDrawdown,
    maxDrawdownPercent,
    averageHoldSeconds: trades.length ? holdSeconds / trades.length : undefined,
    tradesPerWeek:
      duration > 0 ? trades.length / (duration / WEEK_SECONDS) : undefined,
    initialBalance,
    endingBalance: balance,
    equitySeries: undefined,
    maxDepositLoad: undefined,
    balanceSeries,
    daily,
    monthly: [...monthlyByYear.values()].sort(
      (left, right) => left.year - right.year,
    ),
    weekday,
    sources,
  };
}
