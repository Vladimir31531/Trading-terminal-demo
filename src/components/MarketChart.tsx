import {
  Crosshair,
  LoaderCircle,
  Minus,
  MousePointer2,
  MoveRight,
  RectangleHorizontal,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { MarketRepository } from '../application/market-repository';
import type { SimulationEngine } from '../application/simulation-engine';
import type { TradingEngine } from '../application/trading-engine';
import { useMarketChart } from '../chart/use-market-chart';
import type { Instrument, Timeframe } from '../domain/market';
import type { TradeOrder, TradingSnapshot } from '../domain/trading';
import { ChartRuler } from './ChartRuler';
import { TradeEditDialog } from './TradeEditDialog';
import { TradeHistoryOverlay } from './TradeHistoryOverlay';
import { TradingPanel } from './TradingPanel';
import { Button } from './ui/button';

const numberFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 8,
});
const emptyTradingSnapshot: TradingSnapshot = {
  sessionId: '',
  currentTime: 0,
  balance: 0,
  orders: [],
  markers: [],
  finished: true,
};

interface Props {
  instrument: Instrument;
  timeframe: Timeframe;
  timeZone?: string;
  repository: MarketRepository;
  simulation?: SimulationEngine;
  trading?: TradingEngine;
  tradeVolume?: number;
}

export function MarketChart({
  instrument,
  timeframe,
  timeZone = 'UTC',
  repository,
  simulation,
  trading,
  tradeVolume = 0.01,
}: Props) {
  const [editingOrder, setEditingOrder] = useState<TradeOrder>();
  const [tradeActionError, setTradeActionError] = useState<string>();
  const subscribeTrading = useCallback(
    (listener: () => void) => trading?.subscribe(listener) ?? (() => {}),
    [trading],
  );
  const getTradingSnapshot = useCallback(
    () => trading?.getSnapshot() ?? emptyTradingSnapshot,
    [trading],
  );
  const tradingState = useSyncExternalStore(
    subscribeTrading,
    getTradingSnapshot,
    getTradingSnapshot,
  );
  const state = useMarketChart(
    instrument,
    timeframe,
    repository,
    simulation,
    trading,
    tradeVolume,
    setEditingOrder,
    timeZone,
  );

  useEffect(() => {
    if (!state.tradeMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.trade-context-menu'))
        state.closeTradeMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') state.closeTradeMenu();
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [state.tradeMenu, state.closeTradeMenu]);

  function placeLimitFromMenu() {
    if (!trading || !state.tradeMenu) return;
    try {
      trading.placeLimit(
        state.tradeMenu.side,
        state.tradeMenu.price,
        state.tradeMenu.volume,
      );
      state.closeTradeMenu();
      state.clearTradeError();
      setTradeActionError(undefined);
    } catch (cause) {
      state.closeTradeMenu();
      setTradeActionError(
        cause instanceof Error ? cause.message : 'Не удалось выставить ордер.',
      );
    }
  }

  function tradeLevel(
    order: TradeOrder,
    level: 'entry' | 'stopLoss' | 'takeProfit',
    price: number | undefined,
    label: string,
  ) {
    if (price === undefined) return null;
    const coordinate = state.priceToCoordinate(price);
    if (coordinate === null) return null;
    const color =
      level === 'entry'
        ? order.side === 'buy'
          ? 'buy'
          : 'sell'
        : level === 'stopLoss'
          ? 'stop'
          : 'target';
    return (
      <button
        type="button"
        key={`${order.id}:${level}`}
        className={`trade-price-line trade-price-line-${color} ${order.status === 'pending' && level === 'entry' ? 'is-pending' : ''}`}
        data-trade-id={order.id}
        data-trade-level={level}
        style={{ top: coordinate }}
        aria-label={label}
        title="Перетащите уровень; Ctrl + перетаскивание от цены входа добавляет S/L или T/P"
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ')
            setEditingOrder(order);
        }}
      >
        <span>{label}</span>
      </button>
    );
  }

  void state.coordinateRevision;
  return (
    <section
      className="market-chart"
      aria-label={`Свечной график ${instrument.ticker}, ${timeframe}`}
    >
      <div className="chart-details">
        <div className="chart-ohlc">
          {state.candle ? (
            (['open', 'high', 'low', 'close'] as const).map((key, index) => (
              <span key={key}>
                <span className="ohlc-label">
                  {['O', 'H', 'L', 'C'][index]}
                </span>{' '}
                {numberFormat.format(state.candle?.[key] ?? 0)}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">Загрузка свечей…</span>
          )}
        </div>
        <div
          className="chart-data-status"
          aria-live="polite"
          title={
            state.hasMore
              ? 'История подгружается при прокрутке в прошлое'
              : 'Начало доступной истории'
          }
        >
          {state.loadingOlder ? (
            <>
              <LoaderCircle className="size-3 animate-spin" /> История
            </>
          ) : (
            `${state.loadedCount.toLocaleString('ru-RU')} свечей`
          )}
        </div>
      </div>
      <div className="chart-workspace">
        <div
          className="drawing-toolbar"
          role="toolbar"
          aria-label="Инструменты графика"
        >
          <Button
            variant={state.tool === null ? 'secondary' : 'ghost'}
            size="icon"
            title="Курсор · Esc"
            aria-label="Курсор"
            disabled={state.loading}
            onClick={() => state.selectTool(null)}
          >
            <MousePointer2 />
          </Button>
          <div className="toolbar-divider" />
          <Button
            variant={state.tool === 'horizontal-line' ? 'secondary' : 'ghost'}
            size="icon"
            title="Горизонтальная линия · один клик"
            aria-label="Горизонтальная линия"
            disabled={state.loading}
            onClick={() =>
              state.selectTool(
                state.tool === 'horizontal-line' ? null : 'horizontal-line',
              )
            }
          >
            <Minus />
          </Button>
          <Button
            variant={state.tool === 'vertical-line' ? 'secondary' : 'ghost'}
            size="icon"
            title="Вертикальная линия · один клик"
            aria-label="Вертикальная линия"
            disabled={state.loading}
            onClick={() =>
              state.selectTool(
                state.tool === 'vertical-line' ? null : 'vertical-line',
              )
            }
          >
            <Minus className="rotate-90" />
          </Button>
          <Button
            variant={state.tool === 'rectangle' ? 'secondary' : 'ghost'}
            size="icon"
            title="Прямоугольник · два клика по углам"
            aria-label="Прямоугольник"
            disabled={state.loading}
            onClick={() =>
              state.selectTool(state.tool === 'rectangle' ? null : 'rectangle')
            }
          >
            <RectangleHorizontal />
          </Button>
          <div className="toolbar-divider" />
          <Button
            variant={state.crosshair ? 'secondary' : 'ghost'}
            size="icon"
            title="Перекрестие · колёсико мыши. Линейка · перетаскивание левой кнопкой"
            aria-label="Перекрестие"
            aria-pressed={state.crosshair}
            disabled={state.loading}
            onClick={state.toggleCrosshair}
          >
            <Crosshair />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="К последним ценам"
            aria-label="К последним ценам"
            disabled={state.loading}
            onClick={state.latest}
          >
            <MoveRight />
          </Button>
          {state.selected && (
            <>
              <div className="toolbar-divider" />
              <label className="drawing-color" title="Цвет выбранного элемента">
                <span className="sr-only">Цвет элемента</span>
                <input
                  type="color"
                  aria-label="Цвет элемента"
                  value={state.selected.style.color}
                  onInput={(event) => state.recolor(event.currentTarget.value)}
                />
              </label>
              <Button
                variant="ghost"
                size="icon"
                title="Удалить выбранный элемент · Delete"
                aria-label="Удалить выбранный элемент"
                onClick={state.removeSelected}
              >
                <Trash2 />
              </Button>
            </>
          )}
        </div>
        <div ref={state.container} className="chart-canvas">
          <TradeHistoryOverlay layout={state.tradeHistoryLayout} />
          {trading && (
            <fieldset
              className="trading-chart-overlay"
              aria-label="Уровни ордеров"
            >
              {tradingState.orders.map((order) => (
                <Fragment key={order.id}>
                  {tradeLevel(
                    order,
                    'entry',
                    order.price,
                    `${order.side.toUpperCase()} ${order.kind === 'limit' ? 'limit' : 'market'} ${numberFormat.format(order.volume)} @ ${numberFormat.format(order.price)}`,
                  )}
                  {tradeLevel(
                    order,
                    'stopLoss',
                    order.stopLoss,
                    `STOP LOSS ${numberFormat.format(order.stopLoss ?? 0)}`,
                  )}
                  {tradeLevel(
                    order,
                    'takeProfit',
                    order.takeProfit,
                    `TAKE PROFIT ${numberFormat.format(order.takeProfit ?? 0)}`,
                  )}
                </Fragment>
              ))}
            </fieldset>
          )}
          {state.tradeMenu && (
            <div
              className="trade-context-menu"
              role="menu"
              style={{ left: state.tradeMenu.x, top: state.tradeMenu.y }}
            >
              <Button
                type="button"
                role="menuitem"
                onClick={placeLimitFromMenu}
              >
                {state.tradeMenu.side.toUpperCase()} limit{' '}
                {numberFormat.format(state.tradeMenu.volume)}
              </Button>
              <span>{numberFormat.format(state.tradeMenu.price)}</span>
            </div>
          )}
          {(state.tradeError || tradingState.error || tradeActionError) && (
            <div className="trade-chart-error" role="alert">
              {state.tradeError ?? tradingState.error ?? tradeActionError}
            </div>
          )}
          {state.measurement && <ChartRuler measurement={state.measurement} />}
        </div>
        {state.loading && (
          <div className="chart-loading" role="status">
            <LoaderCircle className="size-5 animate-spin" />
            <span>Загрузка графика</span>
          </div>
        )}
        {state.error && (
          <div className="chart-error" role="alert">
            <span>{state.error}</span>
            <Button variant="outline" size="sm" onClick={state.retry}>
              <RotateCcw /> Повторить
            </Button>
          </div>
        )}
        {!state.loading && !state.error && state.loadedCount === 0 && (
          <div className="chart-loading">В этом файле нет свечей.</div>
        )}
        {state.tool && (
          <div className="drawing-hint">
            {state.tool === 'rectangle'
              ? 'Укажите два противоположных угла'
              : 'Нажмите на график, чтобы поставить линию'}
            <span>Esc — отмена</span>
          </div>
        )}
      </div>
      {trading && <TradingPanel engine={trading} onEdit={setEditingOrder} />}
      {trading && (
        <TradeEditDialog
          engine={trading}
          order={editingOrder}
          onOpenChange={(open) => !open && setEditingOrder(undefined)}
        />
      )}
    </section>
  );
}
