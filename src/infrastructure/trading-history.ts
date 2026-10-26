import Dexie, { liveQuery, type Table } from 'dexie';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
  TradingSessionSummary,
} from '../domain/trading';

class TradingDatabase extends Dexie {
  sessions!: Table<TradingSession, string>;
  trades!: Table<ClosedTrade, string>;
  balanceHistory!: Table<BalanceHistoryEntry, string>;

  constructor() {
    super('terminal-demo-trading');
    this.version(1).stores({
      sessions: 'id, instrumentId, startedAt, endedAt',
      trades: 'id, sessionId, [sessionId+openedAt], instrumentId',
    });
    this.version(2).stores({
      sessions: 'id, instrumentId, startedAt, endedAt',
      trades: 'id, sessionId, [sessionId+openedAt], instrumentId',
      balanceHistory: 'id, sessionId, [sessionId+sequence]',
    });
  }
}

const database = new TradingDatabase();

export const tradingHistory = {
  async startSession(session: TradingSession): Promise<void> {
    const { initialBalance, simulationStartTime } = session;
    if (
      initialBalance === undefined ||
      !Number.isFinite(initialBalance) ||
      initialBalance <= 0 ||
      simulationStartTime === undefined ||
      !Number.isFinite(simulationStartTime)
    ) {
      throw new Error('Укажите начальный баланс и время начала симуляции.');
    }
    await database.transaction(
      'rw',
      database.sessions,
      database.balanceHistory,
      async () => {
        await database.sessions.add(session);
        await database.balanceHistory.add({
          id: crypto.randomUUID(),
          sessionId: session.id,
          sequence: 0,
          time: simulationStartTime,
          kind: 'initial',
          change: initialBalance,
          balance: initialBalance,
        });
      },
    );
  },

  async finishSession(sessionId: string, endedAt: number): Promise<void> {
    await database.sessions.update(sessionId, {
      endedAt: Date.now(),
      simulationEndTime: endedAt / 1000,
    });
  },

  async saveClosedTrade(
    trade: ClosedTrade,
    entry: BalanceHistoryEntry,
  ): Promise<void> {
    if (entry.sessionId !== trade.sessionId || entry.tradeId !== trade.id) {
      throw new Error('Запись баланса не соответствует закрытой сделке.');
    }
    await database.transaction(
      'rw',
      database.sessions,
      database.trades,
      database.balanceHistory,
      async () => {
        const session = await database.sessions.get(trade.sessionId);
        if (!session) throw new Error('Торговая сессия больше не существует.');
        await database.trades.add(trade);
        await database.balanceHistory.add(entry);
        await database.sessions.update(trade.sessionId, {
          tradeCount: session.tradeCount + 1,
          totalProfit: session.totalProfit + trade.profit,
          balance: entry.balance,
        });
      },
    );
  },

  watchSessions(
    onChange: (sessions: TradingSessionSummary[]) => void,
    onError: (cause: unknown) => void,
  ): () => void {
    const subscription = liveQuery(() =>
      database.sessions.orderBy('startedAt').reverse().toArray(),
    ).subscribe({ next: onChange, error: onError });
    return () => subscription.unsubscribe();
  },

  async getSession(id: string): Promise<TradingSession | undefined> {
    return database.sessions.get(id);
  },

  watchTrades(
    sessionId: string,
    onChange: (trades: ClosedTrade[]) => void,
    onError: (cause: unknown) => void,
  ): () => void {
    const subscription = liveQuery(() =>
      database.trades
        .where('[sessionId+openedAt]')
        .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
        .sortBy('openedAt'),
    ).subscribe({
      next: (trades) =>
        onChange(
          trades.sort(
            (left, right) =>
              left.openedAt - right.openedAt || left.ticket - right.ticket,
          ),
        ),
      error: onError,
    });
    return () => subscription.unsubscribe();
  },

  watchBalanceHistory(
    sessionId: string,
    onChange: (entries: BalanceHistoryEntry[]) => void,
    onError: (cause: unknown) => void,
  ): () => void {
    const subscription = liveQuery(() =>
      database.balanceHistory
        .where('[sessionId+sequence]')
        .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
        .toArray(),
    ).subscribe({ next: onChange, error: onError });
    return () => subscription.unsubscribe();
  },

  async deleteSession(sessionId: string): Promise<void> {
    await database.transaction(
      'rw',
      database.sessions,
      database.trades,
      database.balanceHistory,
      async () => {
        await database.trades.where('sessionId').equals(sessionId).delete();
        await database.balanceHistory
          .where('sessionId')
          .equals(sessionId)
          .delete();
        await database.sessions.delete(sessionId);
      },
    );
  },
};
