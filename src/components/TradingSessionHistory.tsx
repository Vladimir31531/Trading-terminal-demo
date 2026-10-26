import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from '../domain/trading';

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  dateStyle: 'short',
  timeStyle: 'medium',
});
const priceFormat = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 8,
});
const moneyFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface Props {
  session: TradingSession;
  trades: readonly ClosedTrade[];
  balanceHistory: readonly BalanceHistoryEntry[];
}

export function TradingSessionHistory({
  session,
  trades,
  balanceHistory,
}: Props) {
  const tradeTickets = new Map(trades.map((trade) => [trade.id, trade.ticket]));

  return (
    <div className="session-history">
      <dl className="session-balance-summary">
        <div>
          <dt>Начальный баланс, USD</dt>
          <dd>{formatBalance(session.initialBalance)}</dd>
        </div>
        <div>
          <dt>Баланс, USD</dt>
          <dd>{formatBalance(session.balance)}</dd>
        </div>
      </dl>
      <section className="session-history-section">
        <h3>История сделок</h3>
        <div className="sessions-table-scroll session-history-table-scroll">
          <table className="sessions-table trade-history-table">
            <thead>
              <tr>
                <th>Время открытия UTC</th>
                <th>Время закрытия UTC</th>
                <th>Тип</th>
                <th>Объём</th>
                <th>Вход</th>
                <th>Выход</th>
                <th>Результат, USD</th>
                <th>Причина закрытия</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id}>
                  <td>{dateFormat.format(trade.openedAt * 1000)}</td>
                  <td>{dateFormat.format(trade.closedAt * 1000)}</td>
                  <td>
                    {trade.side.toUpperCase()} {trade.kind}
                  </td>
                  <td>{priceFormat.format(trade.volume)}</td>
                  <td>{priceFormat.format(trade.entryPrice)}</td>
                  <td>{priceFormat.format(trade.exitPrice)}</td>
                  <td
                    className={
                      trade.profit >= 0
                        ? 'trade-profit-positive'
                        : 'trade-profit-negative'
                    }
                  >
                    {moneyFormat.format(trade.profit)}
                  </td>
                  <td>{reasonLabel(trade.closeReason)}</td>
                </tr>
              ))}
              {!trades.length && (
                <tr>
                  <td colSpan={8} className="trading-empty-row">
                    Закрытых сделок пока нет
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="session-history-section">
        <h3>История баланса, USD</h3>
        <div className="sessions-table-scroll session-history-table-scroll">
          <table className="sessions-table trade-history-table">
            <thead>
              <tr>
                <th>Время UTC</th>
                <th>Операция</th>
                <th>Изменение</th>
                <th>Баланс</th>
              </tr>
            </thead>
            <tbody>
              {balanceHistory.map((entry) => (
                <tr key={entry.id}>
                  <td>{dateFormat.format(entry.time * 1000)}</td>
                  <td>
                    {entry.kind === 'initial'
                      ? 'Начальный баланс'
                      : `Закрытие сделки #${entry.tradeId ? (tradeTickets.get(entry.tradeId) ?? '—') : '—'}`}
                  </td>
                  <td
                    className={
                      entry.change >= 0
                        ? 'trade-profit-positive'
                        : 'trade-profit-negative'
                    }
                  >
                    {moneyFormat.format(entry.change)}
                  </td>
                  <td>{moneyFormat.format(entry.balance)}</td>
                </tr>
              ))}
              {!balanceHistory.length && (
                <tr>
                  <td colSpan={4} className="trading-empty-row">
                    Для этой сессии история баланса не записывалась.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function formatBalance(value: number | undefined): string {
  return value === undefined ? '—' : moneyFormat.format(value);
}

function reasonLabel(reason: ClosedTrade['closeReason']): string {
  switch (reason) {
    case 'manual':
      return 'Вручную';
    case 'stop-loss':
      return 'Стоп-лосс';
    case 'take-profit':
      return 'Тейк-профит';
    case 'simulation-end':
      return 'Конец симуляции';
  }
}
