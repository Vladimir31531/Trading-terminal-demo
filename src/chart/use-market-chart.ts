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
  makeCoords,
  type OHLC,
} from 'lightweight-charts-drawing';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketRepository } from '../application/market-repository';
import type { SimulationEngine } from '../application/simulation-engine';
import type { TradingEngine } from '../application/trading-engine';
import type { Candle, Instrument, Timeframe } from '../domain/market';
import { pricePrecision as decimalPlaces } from '../domain/price-precision';
import type { TradeOrder, TradeProtection, TradeSide } from '../domain/trading';
import { bindChartGestures } from './chart-gestures';
import { DaySeparators } from './day-separators';
import { waitForHistoryIdle } from './history-idle';
import {
  type HistoryDirection,
  historyLoadDirection,
  MAX_CACHED_CANDLES,
  mergeHistoryWindow,
} from './history-window';
import { advanceReplayWindow } from './replay-window';
import type { RulerMeasurement } from './ruler';
import { TradeHistory, type TradeHistoryLayout } from './trade-history';
import {
  loadLatestHistory,
  loadViewportHistory,
  type TimeRange,
  viewportLogicalRange,
} from './viewport';

const VISIBLE_BARS = 110;
const PAGE_SIZE = 800;
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
  priceToCoordinate(price: number): number | null;
  latest(): void;
  toggleCrosshair(): void;
  cancelGesture(): void;
}

export function useMarketChart(
  instrument: Instrument,
  timeframe: Timeframe,
  repository: MarketRepository,
  simulation?: SimulationEngine,
  trading?: TradingEngine,
  tradeVolume = 0.01,
  onEditTrade?: (order: TradeOrder) => void,
) {
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<ChartSession | null>(null);
  // Coarse candles must not overwrite the requested intraday dates on a round trip.
  const viewport = useRef<{
    instrumentId: string;
    datasetId: string;
    simulationId?: string;
    range?: TimeRange;
  }>({ instrumentId: instrument.id, datasetId: instrument.datasetId });
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string>();
  const [candle, setCandle] = useState<Candle>();
  const [selected, setSelected] = useState<Drawing>();
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [crosshair, setCrosshair] = useState(false);
  const [measurement, setMeasurement] = useState<RulerMeasurement>();
  const [loadedCount, setLoadedCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const [coordinateRevision, setCoordinateRevision] = useState(0);
  const [tradeHistoryLayout, setTradeHistoryLayout] =
    useState<TradeHistoryLayout>({
      width: 0,
      height: 0,
      markers: [],
    });
  const [tradeMenu, setTradeMenu] = useState<{
    x: number;
    y: number;
    price: number;
    side: TradeSide;
    volume: number;
  }>();
  const [tradeError, setTradeError] = useState<string>();
  const closeTradeMenu = useCallback(() => setTradeMenu(undefined), []);
  const clearTradeError = useCallback(() => setTradeError(undefined), []);
  const tradeOptions = useRef({ trading, tradeVolume, onEditTrade });
  tradeOptions.current = { trading, tradeVolume, onEditTrade };

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries chart initialization after a load error.
  useEffect(() => {
    if (!container.current) return;
    if (
      viewport.current.instrumentId !== instrument.id ||
      viewport.current.datasetId !== instrument.datasetId ||
      viewport.current.simulationId !== simulation?.id
    ) {
      viewport.current = {
        instrumentId: instrument.id,
        datasetId: instrument.datasetId,
        simulationId: simulation?.id,
      };
    }
    const initialRange = viewport.current.range;
    let disposed = false;
    let bars: Candle[] = [];
    let chartBars: OHLC[] = [];
    let forming: Candle | undefined;
    const operation = new AbortController();
    const releaseBootstrap = simulation?.hold();
    let unsubscribeReplay: (() => void) | undefined;
    const history: Pick<MarketRepository, 'loadCandles'> = {
      loadCandles: (datasetId, frame, before, limit, after) =>
        repository.loadCandles(
          datasetId,
          frame,
          before,
          limit,
          after,
          simulation?.getSnapshot().time,
          operation.signal,
        ),
    };
    let more = false;
    let newer = false;
    let replayBehind = false;
    let fetching = false;
    let requestId = 0;
    let pendingHistory: ReturnType<typeof waitForHistoryIdle> | undefined;
    let viewportIdle: ReturnType<typeof waitForHistoryIdle> | undefined;
    let viewportBusy = false;
    const activePointers = new Set<number>();
    let previousRange: { from: number; to: number } | null = null;
    let initialized = false;
    let viewportInteraction = false;
    let observedRange: TimeRange | undefined;
    let pricePrecision = instrument.pricePrecision ?? 0;
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
    setMeasurement(undefined);
    setLoadedCount(0);
    setHasMore(false);
    setTradeHistoryLayout({ width: 0, height: 0, markers: [] });

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
        shiftVisibleRangeOnNewBar: false,
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
    const tradeHistory = new TradeHistory(
      chart,
      timeframe,
      (price) => series.priceToCoordinate(price),
      (layout) => {
        if (!disposed) setTradeHistoryLayout(layout);
      },
    );
    const pane = series.getPane();
    pane.attachPrimitive(tradeHistory);
    let markerCount = -1;
    const syncTradeMarkers = () => {
      const markers = trading?.getSnapshot().markers ?? [];
      if (markers.length === markerCount) return;
      markerCount = markers.length;
      tradeHistory.setMarkers(markers);
    };
    syncTradeMarkers();
    const unsubscribeTrading = trading?.subscribe(syncTradeMarkers);
    const daySeparators = !['1D', '1W', '1M'].includes(timeframe)
      ? new DaySeparators(chart)
      : undefined;
    if (daySeparators) pane.attachPrimitive(daySeparators);
    const manager = new DrawingManager(chart, series, {
      magnet: 'off',
      stayInDrawingMode: false,
      timeInfo: () => ({
        timeZone: 'UTC',
        intraday: !['1D', '1W', '1M'].includes(timeframe),
      }),
    });
    let tradeDrag:
      | {
          pointerId: number;
          id: string;
          level: 'entry' | TradeProtection;
          ctrl: boolean;
          stopLoss?: number;
          takeProfit?: number;
        }
      | undefined;

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
      // Copies already carry their source's complete style.
      if (!manager.tool()) return;
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
      chartBars = bars.map((bar) => ({
        ...bar,
        time: bar.time as UTCTimestamp,
      }));
      daySeparators?.setCandles(bars);
      series.setData(chartBars);
      setLoadedCount(bars.length);
    };
    const updatePricePrecision = (candles: Candle[]) => {
      for (const bar of candles) {
        for (const price of [bar.open, bar.high, bar.low, bar.close]) {
          pricePrecision = Math.max(pricePrecision, decimalPlaces(price));
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
      viewportInteraction = false;
      viewport.current.range = {
        from: bars[Math.max(0, bars.length - VISIBLE_BARS)].time,
        to: bars[bars.length - 1].time,
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
        const page = await history.loadCandles(
          instrument.datasetId,
          timeframe,
          direction === 'older' ? bars[0].time : undefined,
          PAGE_SIZE,
          direction === 'newer' ? bars.at(-1)?.time : undefined,
        );
        if (disposed || currentRequest !== requestId) return;
        // Changing cached indices during a drag invalidates the library's drag origin.
        const idle = waitForHistoryIdle(
          () => chart.timeScale().getVisibleLogicalRange(),
          () => activePointers.size > 0,
        );
        pendingHistory = idle;
        const ready = await idle.ready;
        if (pendingHistory === idle) pendingHistory = undefined;
        if (!ready || disposed || currentRequest !== requestId) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        const window = mergeHistoryWindow(bars, page.candles, direction, range);
        if (!window.preservesViewport) return;
        viewportInteraction = false;
        bars = window.candles;
        if (direction === 'older') {
          more = page.hasMore;
          newer ||= window.removedRight > 0;
        } else {
          // Replay may have advanced while an older snapshot was in flight.
          newer =
            page.hasNewer ||
            !!(forming && forming.time > (bars.at(-1)?.time ?? -Infinity));
          more ||= window.removedLeft > 0;
          if (!newer && forming && bars.at(-1)?.time === forming.time)
            bars[bars.length - 1] = forming;
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
    const latest = async (preserveView = false) => {
      if (disposed || !initialized) return;
      gestures.cancel();
      if (!newer && !fetching) {
        showLatest();
        return;
      }
      // A jump to the end supersedes a page request still in flight.
      pendingHistory?.cancel();
      const currentRequest = ++requestId;
      fetching = true;
      const release = simulation?.hold();
      setLoadingOlder(true);
      setError(undefined);
      try {
        const page = await loadLatestHistory(
          history,
          instrument.datasetId,
          timeframe,
          preserveView ? Math.max(PAGE_SIZE, bars.length) : PAGE_SIZE,
        );
        if (disposed || currentRequest !== requestId) return;
        let retainedRange: { from: number; to: number } | null = null;
        if (preserveView) {
          const idle = waitForHistoryIdle(
            () => chart.timeScale().getVisibleLogicalRange(),
            () => activePointers.size > 0,
          );
          pendingHistory = idle;
          const ready = await idle.ready;
          if (pendingHistory === idle) pendingHistory = undefined;
          if (!ready || disposed || currentRequest !== requestId) return;
          retainedRange = chart.timeScale().getVisibleLogicalRange();
          if (retainedRange && retainedRange.to < bars.length - 1) return;
        }
        const previousCount = bars.length;
        bars = page.candles;
        forming = bars.at(-1);
        more = page.hasMore;
        newer = page.hasNewer;
        replayBehind = false;
        setHasMore(more);
        updatePricePrecision(bars);
        setSeriesData();
        if (retainedRange) {
          const offset = bars.length - previousCount;
          viewportInteraction = false;
          previousRange = {
            from: retainedRange.from + offset,
            to: retainedRange.to + offset,
          };
          chart.timeScale().setVisibleLogicalRange(previousRange);
          const visible = chart.timeScale().getVisibleRange();
          if (
            visible &&
            typeof visible.from === 'number' &&
            typeof visible.to === 'number'
          )
            viewport.current.range = { from: visible.from, to: visible.to };
        } else showLatest();
        setCandle(bars.at(-1));
        manager.redraw();
      } catch (cause) {
        if (currentRequest === requestId) reportError(cause);
      } finally {
        release?.();
        if (currentRequest === requestId) {
          fetching = false;
          if (!disposed) setLoadingOlder(false);
        }
      }
    };
    const rememberViewport = () => {
      const range = chart.timeScale().getVisibleRange();
      if (
        range &&
        typeof range.from === 'number' &&
        typeof range.to === 'number'
      ) {
        // Price-scale and drawing drags leave dates unchanged.
        if (
          initialized &&
          viewportInteraction &&
          observedRange &&
          (range.from !== observedRange.from || range.to !== observedRange.to)
        ) {
          viewport.current.range = { from: range.from, to: range.to };
        }
        observedRange = { from: range.from, to: range.to };
      }
    };
    const onRange = (range: LogicalRange | null) => {
      if (!range || disposed) return;
      setCoordinateRevision((value) => value + 1);
      rememberViewport();
      const previous = previousRange;
      previousRange = range;
      if (fetching || !initialized || !viewportInteraction) return;
      const direction = historyLoadDirection(range, previous, bars.length, {
        older: more,
        newer,
      });
      if (direction) void loadPage(direction);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    const replay = (seconds: readonly Candle[]) => {
      if (disposed || !initialized) return;
      const range = chart.timeScale().getVisibleLogicalRange();
      const following =
        !viewportBusy &&
        !activePointers.size &&
        (!range || range.to >= bars.length - 1);
      const previousCount = bars.length;
      const update = advanceReplayWindow(
        bars,
        forming,
        seconds,
        timeframe,
        newer,
        range,
        viewportBusy || activePointers.size > 0,
      );
      forming = update.forming;
      replayBehind ||= !newer && update.hasNewer;
      newer = update.hasNewer;
      if (!update.changes.length) return;
      setCoordinateRevision((value) => value + 1);
      bars = update.candles;
      if (update.removedLeft) {
        more = true;
        setHasMore(true);
        setSeriesData();
      } else {
        for (const bar of update.changes) {
          const next = { ...bar, time: bar.time as UTCTimestamp };
          if (chartBars.at(-1)?.time === next.time)
            chartBars[chartBars.length - 1] = next;
          else chartBars.push(next);
          series.update(next);
        }
        daySeparators?.setCandles(bars);
        setLoadedCount(bars.length);
      }
      if (range) {
        const offset =
          (following ? bars.length + update.removedLeft - previousCount : 0) -
          update.removedLeft;
        if (offset) {
          viewportInteraction = false;
          previousRange = { from: range.from + offset, to: range.to + offset };
          chart.timeScale().setVisibleLogicalRange(previousRange);
          const visible = chart.timeScale().getVisibleRange();
          if (
            following &&
            visible &&
            typeof visible.from === 'number' &&
            typeof visible.to === 'number'
          )
            viewport.current.range = { from: visible.from, to: visible.to };
        }
      } else showLatest();
      setCandle(bars.at(-1));
      syncTradeMarkers();
      manager.redraw();
    };
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
      gestures.cancel();
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
    const beginTradeDrag = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const handle = target.closest<HTMLElement>(
        '[data-trade-id][data-trade-level]',
      );
      const engine = tradeOptions.current.trading;
      if (!handle || !engine) return;
      const order = engine
        .getSnapshot()
        .orders.find((item) => item.id === handle.dataset.tradeId);
      const level = handle.dataset.tradeLevel;
      if (!order || !['entry', 'stopLoss', 'takeProfit'].includes(level ?? ''))
        return;
      if (level === 'entry' && order.status === 'open' && !event.ctrlKey)
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      tradeDrag = {
        pointerId: event.pointerId,
        id: order.id,
        level: level as 'entry' | TradeProtection,
        ctrl: event.ctrlKey,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
      };
      activePointers.add(event.pointerId);
      handle.setPointerCapture(event.pointerId);
      setTradeError(undefined);
    };
    const navigateViewport = () => {
      viewportInteraction = true;
      if (!simulation) return;
      viewportBusy = true;
      viewportIdle?.cancel();
      const idle = waitForHistoryIdle(
        () => chart.timeScale().getVisibleLogicalRange(),
        () => activePointers.size > 0,
      );
      viewportIdle = idle;
      void idle.ready.then((ready) => {
        if (!ready || viewportIdle !== idle || disposed) return;
        viewportBusy = false;
        const range = chart.timeScale().getVisibleLogicalRange();
        if (
          replayBehind &&
          newer &&
          !fetching &&
          range &&
          range.to >= bars.length - 1
        )
          void latest(true);
      });
    };
    const dragViewport = (event: PointerEvent) => {
      if (tradeDrag?.pointerId === event.pointerId) {
        const drag = tradeDrag;
        const engine = tradeOptions.current.trading;
        const bounds = host.getBoundingClientRect();
        const price = series.coordinateToPrice(event.clientY - bounds.top);
        const order = engine
          ?.getSnapshot()
          .orders.find((item) => item.id === drag.id);
        if (!engine || !order || price === null) return;
        try {
          if (drag.level === 'entry' && drag.ctrl) {
            const higher = price > order.price;
            const field: TradeProtection =
              order.side === 'buy'
                ? higher
                  ? 'takeProfit'
                  : 'stopLoss'
                : higher
                  ? 'stopLoss'
                  : 'takeProfit';
            if (price === order.price) return;
            engine.editOrder(order.id, {
              stopLoss: field === 'stopLoss' ? price : drag.stopLoss,
              takeProfit: field === 'takeProfit' ? price : drag.takeProfit,
            });
          } else if (drag.level === 'entry' && order.status === 'pending') {
            engine.editOrder(order.id, { price });
          } else if (drag.level !== 'entry') {
            engine.setProtection(order.id, drag.level, price);
          }
          setTradeError(undefined);
        } catch (cause) {
          setTradeError(
            cause instanceof Error
              ? cause.message
              : 'Не удалось переместить уровень ордера.',
          );
        }
        return;
      }
      if (event.buttons & 1) navigateViewport();
    };
    const startGesture = (event: PointerEvent) => {
      if (event.button === 0) {
        activePointers.add(event.pointerId);
        if (simulation) navigateViewport();
      }
    };
    const endGesture = (event: PointerEvent) => {
      activePointers.delete(event.pointerId);
      if (tradeDrag?.pointerId === event.pointerId) tradeDrag = undefined;
    };
    const resetGestures = () => {
      activePointers.clear();
      tradeDrag = undefined;
    };
    const contextMenu = (event: MouseEvent) => {
      const { trading: engine, tradeVolume: volume } = tradeOptions.current;
      if (!engine) return;
      const tradingSnapshot = engine.getSnapshot();
      const currentPrice = tradingSnapshot.currentPrice;
      const bounds = host.getBoundingClientRect();
      const price = series.coordinateToPrice(event.clientY - bounds.top);
      if (
        tradingSnapshot.finished ||
        currentPrice === undefined ||
        price === null
      )
        return;
      event.preventDefault();
      setTradeError(undefined);
      setTradeMenu({
        x: Math.max(
          8,
          Math.min(event.clientX - bounds.left + 8, bounds.width - 190),
        ),
        y: Math.max(
          8,
          Math.min(event.clientY - bounds.top, bounds.height - 56),
        ),
        price,
        side: price <= currentPrice ? 'buy' : 'sell',
        volume,
      });
    };
    const doubleClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element) {
        const handle = target.closest<HTMLElement>(
          '[data-trade-id][data-trade-level="entry"]',
        );
        const order = tradeOptions.current.trading
          ?.getSnapshot()
          .orders.find((item) => item.id === handle?.dataset.tradeId);
        if (order) {
          event.preventDefault();
          event.stopImmediatePropagation();
          tradeOptions.current.onEditTrade?.(order);
          return;
        }
      }
      navigateViewport();
    };
    const resizeObserver = new ResizeObserver(() =>
      setCoordinateRevision((value) => value + 1),
    );
    resizeObserver.observe(host);
    host.addEventListener('pointerdown', beginTradeDrag, true);
    host.addEventListener('pointerdown', middleDown, true);
    host.addEventListener('pointerdown', startGesture, true);
    window.addEventListener('pointerup', endGesture, true);
    window.addEventListener('pointercancel', endGesture, true);
    window.addEventListener('blur', resetGestures);
    host.addEventListener('mousedown', preventAutoscroll, true);
    host.addEventListener('auxclick', preventAutoscroll);
    host.addEventListener('wheel', navigateViewport, {
      capture: true,
      passive: true,
    });
    host.addEventListener('pointermove', dragViewport, true);
    host.addEventListener('dblclick', doubleClick, true);
    host.addEventListener('contextmenu', contextMenu);
    const gestures = bindChartGestures({
      host,
      chart,
      series,
      manager,
      coords: makeCoords(chart, series, () => chartBars),
      ready: () => initialized && !disposed,
      crosshair: () => crosshairVisible,
      measure: (next) => {
        if (!disposed) setMeasurement(next);
      },
    });
    session.current = {
      manager,
      priceToCoordinate: (price) => series.priceToCoordinate(price),
      latest,
      toggleCrosshair,
      cancelGesture: gestures.cancel,
    };

    void Promise.all([
      (async () => {
        const page = await loadViewportHistory(
          history,
          instrument.datasetId,
          timeframe,
          initialRange,
        );
        forming =
          simulation && page.hasNewer
            ? (
                await history.loadCandles(
                  instrument.datasetId,
                  timeframe,
                  undefined,
                  1,
                )
              ).candles.at(-1)
            : page.candles.at(-1);
        return page;
      })(),
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
        syncTradeMarkers();
        const scale = chart.timeScale();
        const range =
          initialRange &&
          viewportLogicalRange(
            bars,
            timeframe,
            initialRange,
            Math.min(
              MAX_CACHED_CANDLES,
              (scale.width() || host.clientWidth) /
                scale.options().minBarSpacing,
            ),
          );
        if (range) {
          previousRange = range;
          scale.setVisibleLogicalRange(range);
        } else {
          showLatest();
        }
        if (drawings) manager.importJSON(drawings);
        initialized = true;
        unsubscribeReplay = simulation?.onCandles(replay);
        setCandle(bars.at(-1));
        setLoading(false);
      })
      .catch((cause) => {
        if (!disposed) simulation?.pause();
        reportError(cause);
        if (!disposed) setLoading(false);
      })
      .finally(() => releaseBootstrap?.());

    return () => {
      if (initialized && viewportInteraction) rememberViewport();
      disposed = true;
      operation.abort();
      unsubscribeReplay?.();
      releaseBootstrap?.();
      pendingHistory?.cancel();
      viewportIdle?.cancel();
      gestures.destroy();
      resizeObserver.disconnect();
      clearTimeout(saveTimer);
      saveDrawings();
      session.current = null;
      host.removeEventListener('pointerdown', beginTradeDrag, true);
      host.removeEventListener('pointerdown', middleDown, true);
      host.removeEventListener('pointerdown', startGesture, true);
      window.removeEventListener('pointerup', endGesture, true);
      window.removeEventListener('pointercancel', endGesture, true);
      window.removeEventListener('blur', resetGestures);
      host.removeEventListener('mousedown', preventAutoscroll, true);
      host.removeEventListener('auxclick', preventAutoscroll);
      host.removeEventListener('wheel', navigateViewport, true);
      host.removeEventListener('pointermove', dragViewport, true);
      host.removeEventListener('dblclick', doubleClick, true);
      host.removeEventListener('contextmenu', contextMenu);
      manager.destroy();
      unsubscribeTrading?.();
      pane.detachPrimitive(tradeHistory);
      if (daySeparators) pane.detachPrimitive(daySeparators);
      chart.remove();
    };
  }, [
    instrument.id,
    instrument.datasetId,
    instrument.pricePrecision,
    timeframe,
    repository,
    revision,
    simulation,
    trading,
  ]);

  return {
    container,
    loading,
    loadingOlder,
    error,
    candle,
    selected,
    tool,
    crosshair,
    measurement,
    loadedCount,
    hasMore,
    coordinateRevision,
    tradeHistoryLayout,
    tradeMenu,
    tradeError,
    priceToCoordinate: (price: number) =>
      session.current?.priceToCoordinate(price) ?? null,
    closeTradeMenu,
    clearTradeError,
    selectTool: (kind: DrawingKind | null) => {
      session.current?.cancelGesture();
      session.current?.manager.setTool(kind);
    },
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
