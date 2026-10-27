export type TradeSide = 'buy' | 'sell';
export type TradeKind = 'market' | 'limit';
export type TradeStatus = 'pending' | 'open';
export type TradeProtection = 'stopLoss' | 'takeProfit';
export type TradeCloseReason =
  | 'manual'
  | 'stop-loss'
  | 'take-profit'
  | 'simulation-end';

export interface TradeOrder {
  id: string;
  ticket: number;
  instrumentId: string;
  ticker: string;
  side: TradeSide;
  kind: TradeKind;
  status: TradeStatus;
  volume: number;
  price: number;
  currentPrice: number;
  profit: number;
  placedAt: number;
  openedAt?: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ClosedTrade {
  id: string;
  sessionId: string;
  ticket: number;
  instrumentId: string;
  ticker: string;
  side: TradeSide;
  kind: TradeKind;
  volume: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  profit: number;
  closeReason: TradeCloseReason;
}

export interface TradingSession {
  id: string;
  instrumentId: string;
  datasetId: string;
  ticker: string;
  startedAt: number;
  endedAt?: number;
  tradeCount: number;
  totalProfit: number;
  /** Missing only in sessions created before demo-account balances were added. */
  initialBalance?: number;
  balance?: number;
  /** Replay timestamps, in seconds; startedAt/endedAt are wall-clock milliseconds. */
  simulationStartTime?: number;
  simulationEndTime?: number;
}

export type TradingSessionSummary = TradingSession;

export interface BalanceHistoryEntry {
  id: string;
  sessionId: string;
  sequence: number;
  time: number;
  kind: 'initial' | 'trade';
  change: number;
  balance: number;
  tradeId?: string;
}

export interface TradingSnapshot {
  sessionId: string;
  currentTime: number;
  balance: number;
  currentPrice?: number;
  orders: TradeOrder[];
  markers: TradeMarker[];
  error?: string;
  finished: boolean;
}

export interface TradingCheckpoint {
  snapshot: TradingSnapshot;
  pointValuePer001: number;
  nextTicket: number;
  balanceSequence: number;
}

export interface TradeMarker {
  id: string;
  orderId: string;
  phase: 'open' | 'close';
  time: number;
  price: number;
  side: TradeSide;
}

export interface ProtectionLevels {
  stopLoss?: number;
  takeProfit?: number;
}

export function validateInitialBalance(balance: number): void {
  if (!Number.isFinite(balance) || balance <= 0)
    throw new Error('Баланс демосчёта должен быть числом больше нуля.');
}

export function validateVolume(volume: number): void {
  if (!Number.isFinite(volume) || volume <= 0)
    throw new Error('Объём должен быть числом больше нуля.');
}

export function validatePrice(price: number, field = 'Цена'): void {
  if (!Number.isFinite(price) || price <= 0)
    throw new Error(`${field} должна быть числом больше нуля.`);
}

export function validateProtection(
  side: TradeSide,
  referencePrice: number,
  levels: ProtectionLevels,
): void {
  if (levels.stopLoss !== undefined)
    validatePrice(levels.stopLoss, 'Стоп-лосс');
  if (levels.takeProfit !== undefined)
    validatePrice(levels.takeProfit, 'Тейк-профит');
  if (side === 'buy') {
    if (levels.stopLoss !== undefined && levels.stopLoss >= referencePrice)
      throw new Error('Стоп-лосс BUY должен быть ниже цены входа.');
    if (levels.takeProfit !== undefined && levels.takeProfit <= referencePrice)
      throw new Error('Тейк-профит BUY должен быть выше цены входа.');
  } else {
    if (levels.stopLoss !== undefined && levels.stopLoss <= referencePrice)
      throw new Error('Стоп-лосс SELL должен быть выше цены входа.');
    if (levels.takeProfit !== undefined && levels.takeProfit >= referencePrice)
      throw new Error('Тейк-профит SELL должен быть ниже цены входа.');
  }
}

export function calculateProfit(
  side: TradeSide,
  entryPrice: number,
  currentPrice: number,
  pointSize: number,
  pointValuePer001: number,
  volume: number,
): number {
  const direction = side === 'buy' ? 1 : -1;
  const points = ((currentPrice - entryPrice) / pointSize) * direction;
  return points * pointValuePer001 * (volume / 0.01);
}
