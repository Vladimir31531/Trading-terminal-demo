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
import type { MarketRepository } from '../application/market-repository';
import type { SimulationEngine } from '../application/simulation-engine';
import { useMarketChart } from '../chart/use-market-chart';
import type { Instrument, Timeframe } from '../domain/market';
import { ChartRuler } from './ChartRuler';
import { Button } from './ui/button';

const numberFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 8,
});

interface Props {
  instrument: Instrument;
  timeframe: Timeframe;
  repository: MarketRepository;
  simulation?: SimulationEngine;
}

export function MarketChart({
  instrument,
  timeframe,
  repository,
  simulation,
}: Props) {
  const state = useMarketChart(instrument, timeframe, repository, simulation);
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
    </section>
  );
}
