import { LoaderCircle, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { TradeCharacteristic } from '../domain/trade-characteristics';
import {
  filterTrades,
  type TradeHistoryFilters,
} from '../domain/trade-filters';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from '../domain/trading';
import { CharacteristicFilterSelect } from './CharacteristicFilterSelect';
import { TradeDateFilter } from './TradeDateFilter';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { NativeSelect, NativeSelectOption } from './ui/native-select';

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
  characteristics?: readonly TradeCharacteristic[];
  onDeleteTrade?: (trade: ClosedTrade) => Promise<void>;
}

export function TradingSessionHistory(props: Props) {
  return <SessionHistory key={props.session.id} {...props} />;
}

function SessionHistory({
  session,
  trades,
  balanceHistory,
  characteristics = [],
  onDeleteTrade,
}: Props) {
  const [filters, setFilters] = useState<TradeHistoryFilters>({});
  const [deleting, setDeleting] = useState<ClosedTrade>();
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState<string>();
  const deletionPending = useRef(false);
  const cancelDeletion = useRef<HTMLButtonElement>(null);
  const tradeTickets = new Map(trades.map((trade) => [trade.id, trade.ticket]));
  const characteristicFilters = Object.fromEntries(
    characteristics.map((item) => [
      item.id,
      filters.characteristics?.[item.id],
    ]),
  );
  const filteredTrades = filterTrades(trades, {
    ...filters,
    characteristics: characteristicFilters,
  });
  const hasFilters = Boolean(
    filters.openedAt ||
      filters.closedAt ||
      filters.type ||
      filters.closeReason ||
      Object.values(characteristicFilters).some((value) => value !== undefined),
  );
  const types = [
    ...new Set(trades.map((trade) => `${trade.side} ${trade.kind}`)),
  ].sort();
  const reasons = [...new Set(trades.map((trade) => trade.closeReason))];
  const fallbackTime = session.simulationStartTime ?? session.startedAt / 1000;
  const openingBounds = trades.reduce(
    (range, trade) => ({
      min: Math.min(range.min, trade.openedAt),
      max: Math.max(range.max, trade.openedAt),
    }),
    {
      min: trades[0]?.openedAt ?? fallbackTime,
      max: trades[0]?.openedAt ?? fallbackTime,
    },
  );
  const closingBounds = trades.reduce(
    (range, trade) => ({
      min: Math.min(range.min, trade.closedAt),
      max: Math.max(range.max, trade.closedAt),
    }),
    {
      min: trades[0]?.closedAt ?? fallbackTime,
      max: trades[0]?.closedAt ?? fallbackTime,
    },
  );

  async function deleteSelectedTrade() {
    if (!deleting || !onDeleteTrade || deletionPending.current) return;
    deletionPending.current = true;
    setDeletionBusy(true);
    setDeletionError(undefined);
    try {
      await onDeleteTrade(deleting);
      setFilters({});
      setDeleting(undefined);
    } catch (cause) {
      setDeletionError(
        cause instanceof Error ? cause.message : 'Не удалось удалить сделку.',
      );
    } finally {
      deletionPending.current = false;
      setDeletionBusy(false);
    }
  }

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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="mb-0">История сделок</h3>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground" aria-live="polite">
              Показано {filteredTrades.length} из {trades.length}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={!hasFilters}
              onClick={() => setFilters({})}
            >
              Сбросить фильтры
            </Button>
          </div>
        </div>
        <div className="sessions-table-scroll session-history-table-scroll">
          <table className="sessions-table trade-history-table">
            <thead>
              <tr>
                <th>
                  <div className="grid justify-items-start gap-2">
                    <span>Время открытия UTC</span>
                    <TradeDateFilter
                      id="history-opened-at"
                      label="Время открытия"
                      value={filters.openedAt}
                      onChange={(openedAt) =>
                        setFilters((current) => ({ ...current, openedAt }))
                      }
                      minTime={openingBounds.min}
                      maxTime={openingBounds.max}
                    />
                  </div>
                </th>
                <th>
                  <div className="grid justify-items-start gap-2">
                    <span>Время закрытия UTC</span>
                    <TradeDateFilter
                      id="history-closed-at"
                      label="Время закрытия"
                      value={filters.closedAt}
                      onChange={(closedAt) =>
                        setFilters((current) => ({ ...current, closedAt }))
                      }
                      minTime={closingBounds.min}
                      maxTime={closingBounds.max}
                    />
                  </div>
                </th>
                <th>
                  <div className="grid justify-items-start gap-2">
                    <span>Тип</span>
                    <NativeSelect
                      size="sm"
                      className="bg-white text-xs font-normal"
                      aria-label="Фильтр: Тип"
                      value={filters.type ?? ''}
                      onChange={(event) =>
                        setFilters((current) => ({
                          ...current,
                          type: event.target.value || undefined,
                        }))
                      }
                    >
                      <NativeSelectOption value="">Все типы</NativeSelectOption>
                      {types.map((type) => (
                        <NativeSelectOption key={type} value={type}>
                          {type.replace(/^(buy|sell)/, (side) =>
                            side.toUpperCase(),
                          )}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                </th>
                <th>Объём</th>
                <th>Вход</th>
                <th>Выход</th>
                <th>Результат, USD</th>
                <th>
                  <div className="grid justify-items-start gap-2">
                    <span>Причина закрытия</span>
                    <NativeSelect
                      size="sm"
                      className="bg-white text-xs font-normal"
                      aria-label="Фильтр: Причина закрытия"
                      value={filters.closeReason ?? ''}
                      onChange={(event) =>
                        setFilters((current) => ({
                          ...current,
                          closeReason: event.target.value
                            ? (event.target.value as ClosedTrade['closeReason'])
                            : undefined,
                        }))
                      }
                    >
                      <NativeSelectOption value="">
                        Все причины
                      </NativeSelectOption>
                      {reasons.map((reason) => (
                        <NativeSelectOption key={reason} value={reason}>
                          {reasonLabel(reason)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                </th>
                {characteristics.map((characteristic) => (
                  <th key={characteristic.id}>
                    <div className="grid justify-items-start gap-2">
                      <span>{characteristic.name}</span>
                      <CharacteristicFilterSelect
                        characteristic={characteristic}
                        value={filters.characteristics?.[characteristic.id]}
                        onChange={(value) =>
                          setFilters((current) => ({
                            ...current,
                            characteristics: {
                              ...current.characteristics,
                              [characteristic.id]: value,
                            },
                          }))
                        }
                        knownValues={trades.flatMap((trade) => {
                          const value =
                            trade.characteristics?.[characteristic.id];
                          return value === undefined ? [] : [value];
                        })}
                        idPrefix="history-characteristic-filter"
                      />
                    </div>
                  </th>
                ))}
                {onDeleteTrade && <th aria-label="Удаление сделки" />}
              </tr>
            </thead>
            <tbody>
              {filteredTrades.map((trade) => (
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
                  {characteristics.map((characteristic) => (
                    <td key={characteristic.id}>
                      {trade.characteristics?.[characteristic.id] ?? '-'}
                    </td>
                  ))}
                  {onDeleteTrade && (
                    <td>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Удалить сделку #${trade.ticket}`}
                        title="Удалить сделку из истории"
                        disabled={deletionBusy}
                        onClick={() => {
                          setDeletionError(undefined);
                          setDeleting(trade);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {!filteredTrades.length && (
                <tr>
                  <td
                    colSpan={
                      8 + characteristics.length + (onDeleteTrade ? 1 : 0)
                    }
                    className="trading-empty-row"
                  >
                    {trades.length
                      ? 'Нет сделок по выбранным фильтрам'
                      : 'Закрытых сделок пока нет'}
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
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deletionPending.current) setDeleting(undefined);
        }}
      >
        <DialogContent
          showCloseButton={!deletionBusy}
          className="bg-white"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelDeletion.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (deletionPending.current) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (deletionPending.current) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Удалить сделку из истории?</DialogTitle>
            <DialogDescription>
              Сделка и её характеристики будут удалены без возможности
              восстановления. Баланс и статистика Summary, Profit &amp; Loss и
              Custom будут пересчитаны. Стрелки и соединяющая их линия этой
              сделки исчезнут с графика.
            </DialogDescription>
          </DialogHeader>
          {deleting && (
            <div className="grid gap-1 rounded-md border bg-muted/30 p-3 text-sm">
              <strong>
                {deleting.ticker} · #{deleting.ticket} ·{' '}
                {deleting.side.toUpperCase()} {deleting.kind}
              </strong>
              <span>Объём: {priceFormat.format(deleting.volume)} лота</span>
              <span>Результат: {moneyFormat.format(deleting.profit)} USD</span>
              <span className="text-xs text-muted-foreground">
                Закрыта {dateFormat.format(deleting.closedAt * 1000)} UTC
              </span>
            </div>
          )}
          {deletionError && (
            <p className="form-error" role="alert">
              {deletionError}
            </p>
          )}
          <DialogFooter>
            <Button
              ref={cancelDeletion}
              type="button"
              variant="outline"
              disabled={deletionBusy}
              onClick={() => setDeleting(undefined)}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deletionBusy}
              onClick={() => void deleteSelectedTrade()}
            >
              {deletionBusy && <LoaderCircle className="size-4 animate-spin" />}
              {deletionBusy ? 'Удаляем…' : 'Удалить безвозвратно'}
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
