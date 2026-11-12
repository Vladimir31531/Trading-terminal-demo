import { useMemo, useState } from 'react';
import type { TradeCharacteristic } from '../domain/trade-characteristics';
import {
  analyzeCustomTradingSession,
  type CharacteristicFilters,
} from '../domain/trade-filters';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from '../domain/trading';
import { CharacteristicFilterSelect } from './CharacteristicFilterSelect';
import { SessionSummaryView } from './SessionAnalytics';
import { Button } from './ui/button';
import { Label } from './ui/label';

const countFormat = new Intl.NumberFormat('ru-RU');
const percentFormat = new Intl.NumberFormat('ru-RU', {
  style: 'percent',
  maximumFractionDigits: 2,
});

interface Props {
  session: TradingSession;
  trades: readonly ClosedTrade[];
  balanceHistory: readonly BalanceHistoryEntry[];
  characteristics: readonly TradeCharacteristic[];
}

export function CustomSessionAnalytics({
  session,
  trades,
  balanceHistory,
  characteristics,
}: Props) {
  const [filters, setFilters] = useState<CharacteristicFilters>({});
  const activeFilters = useMemo(
    () =>
      Object.fromEntries(
        characteristics
          .filter((item) => filters[item.id] !== undefined)
          .map((item) => [item.id, filters[item.id]]),
      ),
    [characteristics, filters],
  );
  const analytics = useMemo(
    () =>
      analyzeCustomTradingSession(
        session,
        trades,
        balanceHistory,
        activeFilters,
      ),
    [session, trades, balanceHistory, activeFilters],
  );
  const knownValues = useMemo(
    () =>
      new Map(
        characteristics.map((item) => [
          item.id,
          [
            ...new Set(
              trades
                .filter((trade) => trade.sessionId === session.id)
                .map((trade) => trade.characteristics?.[item.id])
                .filter((value): value is string => value !== undefined),
            ),
          ],
        ]),
      ),
    [characteristics, trades, session.id],
  );
  const totalTrades = trades.filter(
    (trade) => trade.sessionId === session.id,
  ).length;
  const hasFilters = Object.keys(activeFilters).length > 0;

  function changeFilter(id: string, value: string | null | undefined) {
    setFilters((current) => {
      const next = { ...current };
      if (value === undefined) delete next[id];
      else next[id] = value;
      return next;
    });
  }

  return (
    <div className="grid min-w-0 gap-6">
      <section
        className="grid gap-4 rounded-lg border p-4"
        aria-label="Фильтры Custom"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="text-sm font-medium">
              Аналитика по характеристикам
            </h3>
            <p className="text-xs text-muted-foreground">
              Сделка попадает в выборку, если совпадают все выбранные
              характеристики. «Все значения» снимает ограничение, «-» выбирает
              сделки без заполненного значения.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!hasFilters}
            onClick={() => setFilters({})}
          >
            Сбросить фильтры Custom
          </Button>
        </div>
        {characteristics.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {characteristics.map((characteristic) => (
              <div key={characteristic.id} className="grid content-start gap-2">
                <Label htmlFor={`custom-characteristic-${characteristic.id}`}>
                  {characteristic.name}
                </Label>
                <CharacteristicFilterSelect
                  characteristic={characteristic}
                  idPrefix="custom-characteristic"
                  value={activeFilters[characteristic.id]}
                  knownValues={knownValues.get(characteristic.id)}
                  onChange={(value) => changeFilter(characteristic.id, value)}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Характеристики пока не созданы. Добавьте их во вкладке
            «Характеристики сделок» на странице торговых сессий. Сейчас показаны
            все сделки этой сессии.
          </p>
        )}
        <p className="text-xs font-medium tabular-nums" aria-live="polite">
          Отобрано {countFormat.format(analytics.totalTrades)} из{' '}
          {countFormat.format(totalTrades)} сделок
        </p>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <TradeOutcome
          label="Прибыльные сделки"
          count={analytics.wins}
          total={analytics.totalTrades}
          className="trade-profit-positive"
        />
        <TradeOutcome
          label="Убыточные сделки"
          count={analytics.losses}
          total={analytics.totalTrades}
          className="trade-profit-negative"
        />
        <TradeOutcome
          label="Безубыточные сделки"
          count={analytics.breakeven}
          total={analytics.totalTrades}
        />
      </div>
      <p className="-mt-3 text-xs leading-relaxed text-muted-foreground">
        Проценты считаются от всех сделок выборки, включая безубыточные. Кривая
        баланса рассчитывается от начального баланса сессии только по
        результатам выбранных сделок; исключённые сделки не влияют на неё.
        Частота сделок сравнивается за весь период сессии.
      </p>
      {!analytics.totalTrades && (
        <p
          role="status"
          className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
        >
          {totalTrades
            ? 'По выбранным характеристикам сделок нет. Измените значения или сбросьте фильтры.'
            : 'В этой сессии пока нет закрытых сделок.'}
        </p>
      )}
      <SessionSummaryView analytics={analytics} />
    </div>
  );
}

function TradeOutcome({
  label,
  count,
  total,
  className,
}: {
  label: string;
  count: number;
  total: number;
  className?: string;
}) {
  return (
    <dl className="grid gap-2 rounded-lg border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`flex items-baseline gap-2 tabular-nums ${className ?? ''}`}
      >
        <strong className="text-lg font-medium">
          {countFormat.format(count)}
        </strong>
        <span className="text-sm">
          {percentFormat.format(total ? count / total : 0)}
        </span>
      </dd>
    </dl>
  );
}
