import type { Candle, Instrument } from '../domain/market';
import {
  type BalanceHistoryEntry,
  type ClosedTrade,
  calculateProfit,
  type ProtectionLevels,
  type TradeCloseReason,
  type TradeMarker,
  type TradeOrder,
  type TradeProtection,
  type TradeSide,
  type TradingCheckpoint,
  type TradingSession,
  type TradingSnapshot,
  validateInitialBalance,
  validatePrice,
  validateProtection,
  validateVolume,
} from '../domain/trading';
import type { SimulationEngine } from './simulation-engine';

interface TradingHistoryWriter {
  saveClosedTrade(
    trade: ClosedTrade,
    entry: BalanceHistoryEntry,
  ): Promise<void>;
  finishSession(sessionId: string, endedAt: number): Promise<void>;
}

export class TradingEngine {
  private snapshot: TradingSnapshot;
  private pointValuePer001 = 1;
  private ticket = 1;
  private balanceSequence = 0;
  private readonly listeners = new Set<() => void>();
  private unsubscribeCandles?: () => void;
  private unsubscribeSimulation?: () => void;
  private readonly pendingWrites: (() => Promise<void>)[] = [];
  private writeChain = Promise.resolve();
  private closed = false;

  constructor(
    private readonly session: TradingSession,
    private readonly instrument: Instrument,
    private readonly history: TradingHistoryWriter,
  ) {
    if (!Number.isFinite(instrument.pointSize) || instrument.pointSize <= 0)
      throw new Error(
        `Не удалось загрузить сохранённый размер пункта для ${instrument.ticker}. Перезапустите локальный сервис и сохраните настройку инструмента ещё раз.`,
      );
    const initialBalance = session.initialBalance ?? Number.NaN;
    validateInitialBalance(initialBalance);
    this.snapshot = {
      sessionId: session.id,
      currentTime: session.simulationStartTime ?? session.startedAt / 1000,
      balance: initialBalance,
      orders: [],
      markers: [],
      finished: false,
    };
  }

  static restore(
    session: TradingSession,
    instrument: Instrument,
    history: TradingHistoryWriter,
    checkpoint: TradingCheckpoint,
  ): TradingEngine {
    const { snapshot, pointValuePer001, nextTicket, balanceSequence } =
      checkpoint;
    if (
      session.id !== snapshot.sessionId ||
      session.instrumentId !== instrument.id ||
      session.datasetId !== instrument.datasetId ||
      snapshot.finished ||
      !Number.isFinite(snapshot.currentTime) ||
      !Number.isFinite(snapshot.balance) ||
      !Number.isFinite(pointValuePer001) ||
      pointValuePer001 <= 0 ||
      !Number.isSafeInteger(nextTicket) ||
      nextTicket < 1 ||
      !Number.isSafeInteger(balanceSequence) ||
      balanceSequence < 0 ||
      snapshot.orders.some((order) => order.ticket >= nextTicket)
    )
      throw new Error('Некорректное сохранённое состояние торговой сессии.');
    const trading = new TradingEngine(session, instrument, history);
    trading.snapshot = structuredClone(snapshot);
    trading.pointValuePer001 = pointValuePer001;
    trading.ticket = nextTicket;
    trading.balanceSequence = balanceSequence;
    return trading;
  }

  async checkpoint(): Promise<TradingCheckpoint> {
    this.assertActive();
    await this.flushWrites();
    if (this.snapshot.error) throw new Error(this.snapshot.error);
    this.assertActive();
    return {
      snapshot: structuredClone(this.snapshot),
      pointValuePer001: this.pointValuePer001,
      nextTicket: this.ticket,
      balanceSequence: this.balanceSequence,
    };
  }

  detach(): void {
    this.unsubscribeCandles?.();
    this.unsubscribeSimulation?.();
    this.unsubscribeCandles = undefined;
    this.unsubscribeSimulation = undefined;
  }

  getSnapshot = (): TradingSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(simulation: SimulationEngine): void {
    this.detach();
    this.unsubscribeCandles = simulation.onCandles(this.processCandles);
    this.unsubscribeSimulation = simulation.subscribe(() => {
      const status = simulation.getSnapshot().status;
      if (status === 'finished' || status === 'error')
        void this.finish(simulation.getSnapshot().time);
    });
  }

  setPointValuePer001(value: number): void {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error('Цена пункта должна быть числом больше нуля.');
    this.pointValuePer001 = value;
    this.recalculateOpenProfit();
    this.publish();
  }

  openMarket(side: TradeSide, volume: number): void {
    this.assertActive();
    validateVolume(volume);
    const price = this.snapshot.currentPrice;
    if (price === undefined)
      throw new Error('Дождитесь первого изменения цены симуляции.');
    const time = this.snapshot.currentTime;
    const id = crypto.randomUUID();
    this.snapshot.orders = [
      ...this.snapshot.orders,
      {
        id,
        ticket: this.ticket++,
        instrumentId: this.instrument.id,
        ticker: this.instrument.ticker,
        side,
        kind: 'market',
        status: 'open',
        volume,
        price,
        currentPrice: price,
        profit: 0,
        placedAt: time,
        openedAt: time,
      },
    ];
    this.snapshot.markers = [
      ...this.snapshot.markers,
      {
        id: crypto.randomUUID(),
        orderId: id,
        phase: 'open',
        time,
        price,
        side,
      },
    ];
    this.publish();
  }

  placeLimit(side: TradeSide, price: number, volume: number): void {
    this.assertActive();
    validatePrice(price, 'Цена лимитного ордера');
    validateVolume(volume);
    const currentPrice = this.snapshot.currentPrice;
    if (currentPrice === undefined)
      throw new Error('Дождитесь первого изменения цены симуляции.');
    if (
      (side === 'buy' && price >= currentPrice) ||
      (side === 'sell' && price <= currentPrice)
    )
      throw new Error(
        'Лимитный ордер должен находиться по правильную сторону цены.',
      );
    this.snapshot.orders = [
      ...this.snapshot.orders,
      {
        id: crypto.randomUUID(),
        ticket: this.ticket++,
        instrumentId: this.instrument.id,
        ticker: this.instrument.ticker,
        side,
        kind: 'limit',
        status: 'pending',
        volume,
        price,
        currentPrice,
        profit: 0,
        placedAt: this.snapshot.currentTime,
      },
    ];
    this.publish();
  }

  editOrder(
    id: string,
    changes: { price?: number; volume?: number } & ProtectionLevels,
  ): void {
    this.assertActive();
    const order = this.requireOrder(id);
    const volume = changes.volume ?? order.volume;
    validateVolume(volume);
    if (order.status === 'open' && volume !== order.volume)
      throw new Error('Нельзя изменить объём уже открытой сделки.');
    const price = changes.price ?? order.price;
    validatePrice(price, 'Цена ордера');
    const shift = order.status === 'pending' ? price - order.price : 0;
    const referencePrice = order.status === 'open' ? order.currentPrice : price;
    const protection = {
      stopLoss:
        'stopLoss' in changes
          ? changes.stopLoss
          : order.stopLoss === undefined
            ? undefined
            : order.stopLoss + shift,
      takeProfit:
        'takeProfit' in changes
          ? changes.takeProfit
          : order.takeProfit === undefined
            ? undefined
            : order.takeProfit + shift,
    };
    validateProtection(order.side, referencePrice, protection);
    this.snapshot.orders = this.snapshot.orders.map((item) =>
      item.id === id
        ? {
            ...item,
            price,
            volume,
            stopLoss: protection.stopLoss,
            takeProfit: protection.takeProfit,
          }
        : item,
    );
    this.tryFillPending(this.snapshot.currentPrice, this.snapshot.currentTime);
    this.publish();
  }

  setProtection(
    id: string,
    field: TradeProtection,
    value: number | undefined,
  ): void {
    const order = this.requireOrder(id);
    this.editOrder(id, {
      stopLoss: field === 'stopLoss' ? value : order.stopLoss,
      takeProfit: field === 'takeProfit' ? value : order.takeProfit,
    });
  }

  closeOrder(id: string): void {
    this.assertActive();
    const order = this.requireOrder(id);
    if (order.status === 'pending') {
      this.snapshot.orders = this.snapshot.orders.filter(
        (item) => item.id !== id,
      );
      this.publish();
      return;
    }
    this.closePosition(
      order,
      this.snapshot.currentPrice ?? order.price,
      this.snapshot.currentTime,
      'manual',
    );
    this.publish();
  }

  async finish(time = this.snapshot.currentTime): Promise<void> {
    if (this.closed) return this.flushWrites();
    this.closed = true;
    this.detach();
    const exitPrice = this.snapshot.currentPrice;
    for (const order of [...this.snapshot.orders]) {
      if (order.status === 'open' && exitPrice !== undefined)
        this.closePosition(order, exitPrice, time, 'simulation-end');
    }
    this.snapshot.orders = [];
    this.snapshot.currentTime = time;
    this.snapshot.finished = true;
    this.publish();
    this.enqueueWrite(() =>
      this.history.finishSession(this.session.id, time * 1000),
    );
    await this.writeChain;
  }

  private readonly processCandles = (candles: Candle[]): void => {
    for (const candle of candles) {
      this.snapshot.currentTime = candle.time;
      this.snapshot.currentPrice = candle.close;
      const filledOrders = this.tryFillPending(
        candle.close,
        candle.time,
        candle.low,
        candle.high,
      );
      this.checkProtection(
        candle.close,
        candle.time,
        candle.low,
        candle.high,
        filledOrders,
      );
      this.recalculateOpenProfit();
    }
    this.publish();
  };

  private tryFillPending(
    price = this.snapshot.currentPrice,
    time = this.snapshot.currentTime,
    low = price,
    high = price,
  ): Set<string> {
    const filled = new Set<string>();
    if (price === undefined || low === undefined || high === undefined)
      return filled;
    const markers: TradeMarker[] = [];
    this.snapshot.orders = this.snapshot.orders.map((order) => {
      const reached =
        order.status === 'pending' &&
        (order.side === 'buy' ? low <= order.price : high >= order.price);
      if (!reached) return order;
      filled.add(order.id);
      markers.push({
        id: crypto.randomUUID(),
        orderId: order.id,
        phase: 'open',
        time,
        price: order.price,
        side: order.side,
      });
      return {
        ...order,
        status: 'open',
        currentPrice: price,
        openedAt: time,
        profit: calculateProfit(
          order.side,
          order.price,
          price,
          this.instrument.pointSize,
          this.pointValuePer001,
          order.volume,
        ),
      };
    });
    if (markers.length)
      this.snapshot.markers = [...this.snapshot.markers, ...markers];
    return filled;
  }

  private checkProtection(
    price: number,
    time: number,
    low = price,
    high = price,
    filledOrders = new Set<string>(),
  ): void {
    for (const order of [...this.snapshot.orders]) {
      if (order.status !== 'open' || filledOrders.has(order.id)) continue;
      const stopHit =
        order.stopLoss !== undefined &&
        (order.side === 'buy' ? low <= order.stopLoss : high >= order.stopLoss);
      const targetHit =
        order.takeProfit !== undefined &&
        (order.side === 'buy'
          ? high >= order.takeProfit
          : low <= order.takeProfit);
      if (stopHit || targetHit) {
        const reason: TradeCloseReason = stopHit ? 'stop-loss' : 'take-profit';
        const exitPrice = stopHit ? order.stopLoss : order.takeProfit;
        this.closePosition(order, exitPrice ?? price, time, reason);
      }
    }
  }

  private closePosition(
    order: TradeOrder,
    exitPrice: number,
    closedAt: number,
    closeReason: TradeCloseReason,
  ): void {
    const openedAt = order.openedAt ?? order.placedAt;
    const profit = calculateProfit(
      order.side,
      order.price,
      exitPrice,
      this.instrument.pointSize,
      this.pointValuePer001,
      order.volume,
    );
    const closedTrade: ClosedTrade = {
      id: crypto.randomUUID(),
      sessionId: this.session.id,
      ticket: order.ticket,
      instrumentId: order.instrumentId,
      ticker: order.ticker,
      side: order.side,
      kind: order.kind,
      volume: order.volume,
      entryPrice: order.price,
      exitPrice,
      openedAt,
      closedAt,
      profit,
      closeReason,
    };
    this.snapshot.orders = this.snapshot.orders.filter(
      (item) => item.id !== order.id,
    );
    this.snapshot.markers = [
      ...this.snapshot.markers,
      {
        id: crypto.randomUUID(),
        orderId: order.id,
        phase: 'close',
        time: closedAt,
        price: exitPrice,
        side: order.side,
      },
    ];
    this.snapshot.balance += profit;
    const balanceEntry: BalanceHistoryEntry = {
      id: crypto.randomUUID(),
      sessionId: this.session.id,
      sequence: ++this.balanceSequence,
      time: closedAt,
      kind: 'trade',
      change: profit,
      balance: this.snapshot.balance,
      tradeId: closedTrade.id,
    };
    this.enqueueWrite(() =>
      this.history.saveClosedTrade(closedTrade, balanceEntry),
    );
  }

  private recalculateOpenProfit(): void {
    const currentPrice = this.snapshot.currentPrice;
    if (currentPrice === undefined) return;
    this.snapshot.orders = this.snapshot.orders.map((order) => ({
      ...order,
      currentPrice,
      profit:
        order.status === 'open'
          ? calculateProfit(
              order.side,
              order.price,
              currentPrice,
              this.instrument.pointSize,
              this.pointValuePer001,
              order.volume,
            )
          : 0,
    }));
  }

  private requireOrder(id: string): TradeOrder {
    const order = this.snapshot.orders.find((item) => item.id === id);
    if (!order) throw new Error('Ордер уже закрыт или удалён.');
    return order;
  }

  private assertActive(): void {
    if (this.closed || this.snapshot.finished)
      throw new Error('Торговая сессия уже завершена.');
  }

  private enqueueWrite(write: () => Promise<void>): void {
    this.pendingWrites.push(write);
    void this.flushWrites();
  }

  private flushWrites(): Promise<void> {
    this.writeChain = this.writeChain
      .then(async () => {
        while (this.pendingWrites.length) {
          await this.pendingWrites[0]();
          this.pendingWrites.shift();
        }
        if (this.snapshot.error) {
          this.snapshot.error = undefined;
          this.publish();
        }
      })
      .catch((cause: unknown) => {
        this.snapshot.error =
          cause instanceof Error
            ? `Не удалось сохранить историю: ${cause.message}`
            : 'Не удалось сохранить историю торговой сессии.';
        this.publish();
      });
    return this.writeChain;
  }

  private publish(): void {
    this.snapshot = { ...this.snapshot };
    for (const listener of this.listeners) listener();
  }
}
