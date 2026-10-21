import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  type Drawing,
  type DrawingKind,
  DrawingManager,
} from 'lightweight-charts-drawing';
import { useEffect, useRef, useState } from 'react';
import type { MarketRepository } from '../application/market-repository';
import type { Candle, Instrument, Timeframe } from '../domain/market';
import { type HistoryDirection, mergeHistoryWindow } from './history-window';

const VISIBLE_BARS = 110;
const PAGE_SIZE = 800;
const HISTORY_THRESHOLD = 80;
const utcDate = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

interface ChartSession {
  manager: DrawingManager;
  latest(): void;
  toggleCrosshair(): void;
}

export function useMarketChart(
  instrument: Instrument,
  timeframe: Timeframe,
  repository: MarketRepository,
) {
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<ChartSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string>();
  const [candle, setCandle] = useState<Candle>();
  const [selected, setSelected] = useState<Drawing>();
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [crosshair, setCrosshair] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries chart initialization after a load error.
  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let bars: Candle[] = [];
    let more = false;
    let newer = false;
    let fetching = false;
    let requestId = 0;
    let previousRange: { from: number; to: number } | null = null;
    let initialized = false;
    let pricePrecision = 0;
    let crosshairVisible = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const host = container.current;
    setLoading(true);
    setLoadingOlder(false);
    setError(undefined);
    setCandle(undefined);
    setSelected(undefined);
    setTool(null);
    setCrosshair(false);
    setLoadedCount(0);
    setHasMore(false);

    const reportError = (cause: unknown) => {
      if (!disposed)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось загрузить данные графика.',
        );
    };
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#737373',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: '#f3f3f3' },
        horzLines: { color: '#f3f3f3' },
      },
      rightPriceScale: {
        borderColor: '#e8e8e8',
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: '#e8e8e8',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 9,
      },
      crosshair: {
        mode: CrosshairMode.Hidden,
        vertLine: { color: '#737373', labelBackgroundColor: '#171717' },
        horzLine: { color: '#737373', labelBackgroundColor: '#171717' },
      },
      localization: {
        locale: 'ru-RU',
        timeFormatter: (time: Time) =>
          typeof time === 'number'
            ? `${utcDate.format(time * 1000)} UTC`
            : String(time),
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#ffffff',
      downColor: '#000000',
      borderUpColor: '#000000',
      borderDownColor: '#000000',
      wickUpColor: '#000000',
      wickDownColor: '#000000',
      priceLineColor: '#737373',
    });
    const manager = new DrawingManager(chart, series, {
      magnet: 'off',
      stayInDrawingMode: false,
      timeInfo: () => ({
        timeZone: 'UTC',
        intraday: !['1D', '1W', '1M'].includes(timeframe),
      }),
    });

    const saveDrawings = () => {
      if (!initialized) return;
      const json = manager.exportJSON();
      void repository.saveDrawings(instrument.id, json).catch(reportError);
    };
    manager.on('change', () => {
      if (!initialized) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDrawings, 200);
      const id = manager.selection()[0];
      setSelected(id ? manager.get(id) : undefined);
    });
    manager.on('selection', (ids) => {
      if (!disposed) setSelected(ids[0] ? manager.get(ids[0]) : undefined);
    });
    manager.on('tool', (kind) => {
      if (!disposed) setTool(kind);
    });
    manager.on('add', (drawing) => {
      manager.update({
        ...drawing,
        style: {
          ...drawing.style,
          color: '#171717',
          backgroundColor: '#a3a3a3',
          transparency: 85,
        },
      });
    });

    const setSeriesData = () => {
      series.setData(
        bars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })),
      );
      setLoadedCount(bars.length);
    };
    const updatePricePrecision = (candles: Candle[]) => {
      for (const bar of candles) {
        for (const price of [bar.open, bar.high, bar.low, bar.close]) {
          const decimals =
            price.toFixed(8).replace(/0+$/, '').split('.')[1]?.length ?? 0;
          pricePrecision = Math.max(pricePrecision, decimals);
        }
      }
      series.applyOptions({
        priceFormat: {
          type: 'price',
          precision: pricePrecision,
          minMove: 10 ** -pricePrecision,
        },
      });
    };
    const showLatest = () => {
      if (!bars.length) return;
      series.priceScale().applyOptions({ autoScale: true });
      previousRange = {
        from: Math.max(-5, bars.length - VISIBLE_BARS),
        to: bars.length + 5,
      };
      chart.timeScale().setVisibleLogicalRange(previousRange);
    };
    const loadPage = async (direction: HistoryDirection) => {
      if (
        disposed ||
        !initialized ||
        fetching ||
        !(direction === 'older' ? more : newer) ||
        !bars.length
      )
        return;
      const currentRequest = ++requestId;
      fetching = true;
      setLoadingOlder(true);
      setError(undefined);
      try {
        const page = await repository.loadCandles(
          instrument.datasetId,
          timeframe,
          direction === 'older' ? bars[0].time : undefined,
          PAGE_SIZE,
          direction === 'newer' ? bars.at(-1)?.time : undefined,
        );
        if (disposed || currentRequest !== requestId) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        const window = mergeHistoryWindow(bars, page.candles, direction);
        bars = window.candles;
        if (direction === 'older') {
          more = page.hasMore;
          newer ||= window.removedRight > 0;
        } else {
          newer = page.hasNewer;
          more ||= window.removedLeft > 0;
        }
        setHasMore(more);
        updatePricePrecision(page.candles);
        setSeriesData();
        if (range) {
          previousRange = {
            from: range.from + window.logicalOffset,
            to: range.to + window.logicalOffset,
          };
          chart.timeScale().setVisibleLogicalRange({
            from: previousRange.from,
            to: previousRange.to,
          });
        }
        manager.redraw();
      } catch (cause) {
        if (currentRequest === requestId) reportError(cause);
      } finally {
        if (currentRequest === requestId) {
          fetching = false;
          if (!disposed) setLoadingOlder(false);
        }
      }
    };
    const latest = async () => {
      if (disposed || !initialized) return;
      if (!newer && !fetching) {
        showLatest();
        return;
      }
      // A jump to the end supersedes a page request still in flight.
      const currentRequest = ++requestId;
      fetching = true;
      setLoadingOlder(true);
      setError(undefined);
      try {
        const page = await repository.loadCandles(
          instrument.datasetId,
          timeframe,
          undefined,
          PAGE_SIZE,
        );
        if (disposed || currentRequest !== requestId) return;
        bars = page.candles;
        more = page.hasMore;
        newer = page.hasNewer;
        setHasMore(more);
        updatePricePrecision(bars);
        setSeriesData();
        showLatest();
        setCandle(bars.at(-1));
        manager.redraw();
      } catch (cause) {
        if (currentRequest === requestId) reportError(cause);
      } finally {
        if (currentRequest === requestId) {
          fetching = false;
          if (!disposed) setLoadingOlder(false);
        }
      }
    };
    const onRange = (range: LogicalRange | null) => {
      if (!range || fetching) return;
      const previous = previousRange;
      previousRange = range;
      const nearStart = range.from < HISTORY_THRESHOLD && more;
      const nearEnd = range.to > bars.length - HISTORY_THRESHOLD && newer;
      if (nearStart && nearEnd) {
        // A wide viewport can reach both ends. Follow the actual pan direction.
        if (previous && range.from < previous.from && range.to < previous.to)
          void loadPage('older');
        else if (
          previous &&
          range.from > previous.from &&
          range.to > previous.to
        )
          void loadPage('newer');
      } else if (nearStart) void loadPage('older');
      else if (nearEnd) void loadPage('newer');
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.subscribeCrosshairMove((event) => {
      const point = event.seriesData.get(series);
      const next =
        point && 'open' in point
          ? { ...point, time: Number(point.time) }
          : bars.at(-1);
      if (!disposed)
        setCandle((previous) =>
          previous?.time === next?.time ? previous : next,
        );
    });

    const toggleCrosshair = () => {
      crosshairVisible = !crosshairVisible;
      chart.applyOptions({
        crosshair: {
          mode: crosshairVisible ? CrosshairMode.Normal : CrosshairMode.Hidden,
        },
      });
      if (!crosshairVisible) chart.clearCrosshairPosition();
      setCrosshair(crosshairVisible);
    };
    const middleDown = (event: PointerEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleCrosshair();
      if (!crosshairVisible) return;
      const bounds = host.getBoundingClientRect();
      const price = series.coordinateToPrice(event.clientY - bounds.top);
      const time = chart
        .timeScale()
        .coordinateToTime(event.clientX - bounds.left);
      if (price !== null && time !== null)
        chart.setCrosshairPosition(price, time, series);
    };
    const preventAutoscroll = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    host.addEventListener('pointerdown', middleDown, true);
    host.addEventListener('mousedown', preventAutoscroll, true);
    host.addEventListener('auxclick', preventAutoscroll);
    session.current = {
      manager,
      latest,
      toggleCrosshair,
    };

    void Promise.all([
      repository.loadCandles(
        instrument.datasetId,
        timeframe,
        undefined,
        PAGE_SIZE,
      ),
      repository.loadDrawings(instrument.id),
    ])
      .then(([page, drawings]) => {
        if (disposed) return;
        bars = page.candles;
        more = page.hasMore;
        newer = page.hasNewer;
        setHasMore(more);
        updatePricePrecision(bars);
        setSeriesData();
        showLatest();
        if (drawings) manager.importJSON(drawings);
        initialized = true;
        setCandle(bars.at(-1));
        setLoading(false);
      })
      .catch((cause) => {
        reportError(cause);
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
      clearTimeout(saveTimer);
      saveDrawings();
      session.current = null;
      host.removeEventListener('pointerdown', middleDown, true);
      host.removeEventListener('mousedown', preventAutoscroll, true);
      host.removeEventListener('auxclick', preventAutoscroll);
      manager.destroy();
      chart.remove();
    };
  }, [instrument.id, instrument.datasetId, timeframe, repository, revision]);

  return {
    container,
    loading,
    loadingOlder,
    error,
    candle,
    selected,
    tool,
    crosshair,
    loadedCount,
    hasMore,
    selectTool: (kind: DrawingKind | null) =>
      session.current?.manager.setTool(kind),
    recolor: (color: string) => {
      const manager = session.current?.manager;
      const id = manager?.selection()[0];
      const drawing = id ? manager?.get(id) : undefined;
      if (drawing)
        manager?.update({
          ...drawing,
          style: { ...drawing.style, color, backgroundColor: color },
        });
    },
    removeSelected: () => {
      const manager = session.current?.manager;
      for (const id of manager?.selection() ?? []) manager?.remove(id);
    },
    latest: () => session.current?.latest(),
    toggleCrosshair: () => session.current?.toggleCrosshair(),
    retry: () => setRevision((value) => value + 1),
  };
}
