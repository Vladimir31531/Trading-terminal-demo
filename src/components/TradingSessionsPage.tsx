import { ArrowLeft, LoaderCircle, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSessionSummary,
} from '../domain/trading';
import { tradingHistory } from '../infrastructure/trading-history';
import { SessionProfitLoss, SessionSummary } from './SessionAnalytics';
import { TradingSessionHistory } from './TradingSessionHistory';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  dateStyle: 'short',
  timeStyle: 'medium',
});
const moneyFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface Props {
  onBack: () => void;
  onBeforeDelete: (sessionId: string) => Promise<void>;
}

export function TradingSessionsPage({ onBack, onBeforeDelete }: Props) {
  const [sessions, setSessions] = useState<TradingSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [trades, setTrades] = useState<ClosedTrade[]>([]);
  const [balanceHistory, setBalanceHistory] = useState<BalanceHistoryEntry[]>(
    [],
  );
  const [deleting, setDeleting] = useState<TradingSessionSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [deletionError, setDeletionError] = useState<string>();
  const [tradesLoading, setTradesLoading] = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [tradesError, setTradesError] = useState<string>();
  const [balanceError, setBalanceError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const selected = sessions.find((session) => session.id === selectedId);
  const detailError = error ?? tradesError ?? balanceError;

  useEffect(() => {
    return tradingHistory.watchSessions(
      (items) => {
        setSessions(items);
        setLoading(false);
      },
      (cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось прочитать торговые сессии.',
        );
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    setTrades([]);
    setBalanceHistory([]);
    setTradesError(undefined);
    setBalanceError(undefined);
    setTradesLoading(Boolean(selectedId));
    setBalanceLoading(Boolean(selectedId));
    if (!selectedId) return;
    const unsubscribeTrades = tradingHistory.watchTrades(
      selectedId,
      (items) => {
        setTrades(items);
        setTradesLoading(false);
      },
      (cause) => {
        setTradesError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось прочитать историю сделок.',
        );
        setTradesLoading(false);
      },
    );
    const unsubscribeBalance = tradingHistory.watchBalanceHistory(
      selectedId,
      (items) => {
        setBalanceHistory(items);
        setBalanceLoading(false);
      },
      (cause) => {
        setBalanceError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось прочитать историю баланса.',
        );
        setBalanceLoading(false);
      },
    );
    return () => {
      unsubscribeTrades();
      unsubscribeBalance();
    };
  }, [selectedId]);

  function openSession(sessionId: string) {
    setTradesLoading(true);
    setBalanceLoading(true);
    setTradesError(undefined);
    setBalanceError(undefined);
    setSelectedId(sessionId);
  }

  async function removeSelected() {
    if (!deleting) return;
    setBusy(true);
    setDeletionError(undefined);
    try {
      await onBeforeDelete(deleting.id);
      await tradingHistory.deleteSession(deleting.id);
      setDeleting(undefined);
      if (selectedId === deleting.id) setSelectedId(undefined);
    } catch (cause) {
      setDeletionError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось удалить торговую сессию.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`sessions-page${selectedId ? ' session-detail-page' : ''}`}>
      <div
        className={`sessions-page-header${selectedId ? ' session-detail-header' : ''}`}
      >
        <div>
          <span className="eyebrow">ЖУРНАЛ ТОРГОВЛИ</span>
          <h2>
            {selectedId
              ? (selected?.ticker ?? 'Торговая сессия')
              : 'Торговые сессии'}
          </h2>
          <p>
            {selectedId
              ? selected &&
                `Сессия от ${dateFormat.format(selected.startedAt)} UTC`
              : 'Закрытые сделки и история баланса каждой симуляции.'}
          </p>
        </div>
        <div className="session-detail-actions">
          {selectedId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedId(undefined)}
            >
              <ArrowLeft size={14} /> Назад к списку
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onBack}>
            К графику
          </Button>
        </div>
      </div>
      {!selectedId && error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {selectedId ? (
        detailError ? (
          <div className="sessions-state" role="alert">
            {detailError}
          </div>
        ) : loading || tradesLoading || balanceLoading ? (
          <div className="sessions-state" role="status">
            <LoaderCircle className="animate-spin" size={18} /> Загружаем
            историю сессии…
          </div>
        ) : selected ? (
          <Tabs
            key={selected.id}
            defaultValue="history"
            className="session-detail-tabs"
          >
            <TabsList aria-label="Разделы торговой сессии">
              <TabsTrigger value="history">История сделок</TabsTrigger>
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="profit-loss">Profit &amp; Loss</TabsTrigger>
            </TabsList>
            <TabsContent value="history" className="session-tab-content">
              <TradingSessionHistory
                session={selected}
                trades={trades}
                balanceHistory={balanceHistory}
              />
            </TabsContent>
            <TabsContent value="summary" className="session-tab-content">
              <SessionSummary
                session={selected}
                trades={trades}
                balanceHistory={balanceHistory}
              />
            </TabsContent>
            <TabsContent value="profit-loss" className="session-tab-content">
              <SessionProfitLoss
                session={selected}
                trades={trades}
                balanceHistory={balanceHistory}
              />
            </TabsContent>
          </Tabs>
        ) : (
          <div className="sessions-state">
            Торговая сессия больше не существует.
          </div>
        )
      ) : loading ? (
        <div className="sessions-state">
          <LoaderCircle className="animate-spin" size={18} /> Загружаем сессии…
        </div>
      ) : sessions.length ? (
        <div className="sessions-table-scroll">
          <table className="sessions-table">
            <thead>
              <tr>
                <th>Инструмент</th>
                <th>Начало UTC</th>
                <th>Завершена UTC</th>
                <th>Сделок</th>
                <th>Начальный баланс, USD</th>
                <th>Баланс, USD</th>
                <th>Результат</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>
                    <button
                      type="button"
                      className="session-open"
                      onClick={() => openSession(session.id)}
                    >
                      {session.ticker}
                    </button>
                  </td>
                  <td>{dateFormat.format(session.startedAt)}</td>
                  <td>
                    {session.endedAt
                      ? dateFormat.format(session.endedAt)
                      : 'Активна'}
                  </td>
                  <td>{session.tradeCount}</td>
                  <td>{formatBalance(session.initialBalance)}</td>
                  <td>{formatBalance(session.balance)}</td>
                  <td
                    className={
                      session.totalProfit >= 0
                        ? 'trade-profit-positive'
                        : 'trade-profit-negative'
                    }
                  >
                    {moneyFormat.format(session.totalProfit)}
                  </td>
                  <td>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Удалить сессию ${session.ticker} от ${dateFormat.format(session.startedAt)}`}
                      title="Удалить сессию"
                      onClick={() => {
                        setDeletionError(undefined);
                        setDeleting(session);
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sessions-state">
          Торговых сессий пока нет. Они появятся после запуска симуляции.
        </div>
      )}
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !busy && !open && setDeleting(undefined)}
      >
        <DialogContent className="session-delete-dialog">
          <DialogHeader>
            <DialogTitle>Удалить торговую сессию?</DialogTitle>
            <DialogDescription>
              История сделок и баланса этой сессии будет удалена.
            </DialogDescription>
          </DialogHeader>
          {deletionError && (
            <p className="form-error" role="alert">
              {deletionError}
            </p>
          )}
          <DialogFooter className="dialog-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void removeSelected()}
            >
              {busy ? 'Удаляем…' : 'Удалить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatBalance(value: number | undefined): string {
  return value === undefined ? '—' : moneyFormat.format(value);
}
