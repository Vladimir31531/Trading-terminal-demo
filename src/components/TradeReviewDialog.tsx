import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { SimulationEngine } from '../application/simulation-engine';
import type { TradingEngine } from '../application/trading-engine';
import {
  type TradeCharacteristic,
  validateTradeCharacteristicSelections,
} from '../domain/trade-characteristics';
import type { PendingTradeReview } from '../domain/trading';
import { tradingHistory } from '../infrastructure/trading-history';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Label } from './ui/label';
import { NativeSelect, NativeSelectOption } from './ui/native-select';

const noReviews: PendingTradeReview[] = [];
const moneyFormat = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'USD',
});
const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  dateStyle: 'short',
  timeStyle: 'medium',
});

interface Props {
  engine?: TradingEngine;
  simulation?: SimulationEngine;
}

/** Also recovers staged executions after the application was closed. */
export function TradeReviewDialog({ engine, simulation }: Props) {
  const [staged, setStaged] = useState<PendingTradeReview[]>([]);
  const [characteristics, setCharacteristics] = useState<TradeCharacteristic[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const subscribe = useCallback(
    (listener: () => void) => engine?.subscribe(listener) ?? (() => {}),
    [engine],
  );
  const getReviews = useCallback(
    () => engine?.getSnapshot().pendingTradeReviews ?? noReviews,
    [engine],
  );
  const active = useSyncExternalStore(subscribe, getReviews, getReviews);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry restarts subscriptions after an IndexedDB read failure.
  useEffect(() => {
    setLoading(true);
    setLoadError(undefined);
    const onError = (cause: unknown) => {
      setLoadError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось прочитать характеристики сделок.',
      );
      setLoading(false);
    };
    const stopCharacteristics = tradingHistory.watchCharacteristics((items) => {
      setCharacteristics(items);
      setLoading(false);
    }, onError);
    const stopReviews = tradingHistory.watchPendingTradeReviews(
      setStaged,
      onError,
    );
    return () => {
      stopCharacteristics();
      stopReviews();
    };
  }, [retry]);

  const reviews = [
    ...new Map(
      [...staged, ...active].map((item) => [item.trade.id, item]),
    ).values(),
  ].sort(
    (left, right) =>
      left.trade.sessionId.localeCompare(right.trade.sessionId) ||
      left.balanceEntry.sequence - right.balanceEntry.sequence,
  );
  const review = reviews[0];
  const needsReview = Boolean(review);
  const canContinue =
    simulation !== undefined &&
    !['finished', 'error'].includes(simulation.getSnapshot().status);
  useEffect(() => {
    if (!needsReview || !simulation) return;
    simulation.pause();
    return simulation.hold();
  }, [needsReview, simulation]);

  async function save(characteristics: Record<string, string>) {
    if (!review) return;
    if (active.some((item) => item.trade.id === review.trade.id) && engine)
      await engine.saveTradeReview(review.trade.id, characteristics);
    else
      await tradingHistory.saveClosedTrade(
        { ...review.trade, characteristics },
        review.balanceEntry,
      );
    setStaged((items) =>
      items.filter((item) => item.trade.id !== review.trade.id),
    );
  }

  return (
    <Dialog open={needsReview || Boolean(loadError)}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-white"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Характеристики закрытой сделки</DialogTitle>
          <DialogDescription>
            {canContinue
              ? 'Симуляция на паузе.'
              : 'Цена и результат сделки зафиксированы.'}{' '}
            Заполните характеристики перед записью сделки в историю.
            {reviews.length > 1 && ` Осталось сделок: ${reviews.length}.`}
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <>
            <p className="form-error" role="alert">
              {loadError}
            </p>
            <Button onClick={() => setRetry((value) => value + 1)}>
              Повторить загрузку
            </Button>
          </>
        ) : review ? (
          <TradeReviewForm
            key={review.trade.id}
            review={review}
            characteristics={characteristics}
            canContinue={canContinue}
            loading={loading}
            onSave={save}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function TradeReviewForm({
  review,
  characteristics,
  canContinue,
  loading,
  onSave,
}: {
  review: PendingTradeReview;
  characteristics: readonly TradeCharacteristic[];
  canContinue: boolean;
  loading: boolean;
  onSave: (values: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { trade } = review;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || loading) return;
    setError(undefined);
    try {
      const selected = Object.fromEntries(
        characteristics.map((item) => [item.id, values[item.id] ?? '']),
      );
      validateTradeCharacteristicSelections(characteristics, selected);
      setBusy(true);
      await onSave(selected);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось сохранить сделку. Повторите попытку.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-5">
      <div className="rounded-md border bg-muted/30 p-3 text-sm">
        <div className="flex flex-wrap justify-between gap-2 font-medium">
          <span>
            {trade.ticker} · #{trade.ticket} · {trade.side.toUpperCase()}{' '}
            {trade.volume}
          </span>
          <span
            className={
              trade.profit >= 0
                ? 'trade-profit-positive'
                : 'trade-profit-negative'
            }
          >
            {moneyFormat.format(trade.profit)}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Закрыта {timeFormat.format(trade.closedAt * 1000)} UTC
        </p>
      </div>
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" /> Загружаем
          характеристики…
        </p>
      ) : characteristics.length ? (
        characteristics.map((item) => (
          <div key={item.id} className="grid gap-2">
            <Label htmlFor={`trade-characteristic-${item.id}`}>
              {item.name}
            </Label>
            <NativeSelect
              id={`trade-characteristic-${item.id}`}
              className="min-w-64 max-w-full bg-white"
              value={
                item.values.includes(values[item.id]) ? values[item.id] : ''
              }
              required
              disabled={busy}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [item.id]: event.target.value,
                }))
              }
            >
              <NativeSelectOption value="">
                Выберите значение
              </NativeSelectOption>
              {item.values.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">
          Характеристики пока не созданы. Их можно добавить в разделе «Торговые
          сессии» → «Характеристики сделок». Эта сделка сохранится без
          характеристик.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={busy || loading}>
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          {busy ? 'Сохраняем…' : 'Сохранить в историю'}
        </Button>
      </DialogFooter>
      {canContinue && (
        <p className="text-xs text-muted-foreground">
          После сохранения симуляция останется на паузе. Продолжить — кнопка ▶
          или пробел.
        </p>
      )}
    </form>
  );
}
