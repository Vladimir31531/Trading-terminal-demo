import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Coords, DrawingManager, Pt } from 'lightweight-charts-drawing';
import { findDrawingAt, prepareDrawingCopy } from './drawing-copy';
import type { RulerMeasurement } from './ruler';

interface GestureOptions {
  host: HTMLElement;
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  manager: Pick<
    DrawingManager,
    | 'drawings'
    | 'drawingsVisible'
    | 'selection'
    | 'select'
    | 'tool'
    | 'setTool'
    | 'add'
    | 'update'
    | 'remove'
  >;
  coords: Coords;
  ready(): boolean;
  crosshair(): boolean;
  measure(measurement: RulerMeasurement | undefined): void;
}

/** Own only copy/ruler drags; all other gestures remain with the chart library. */
export function bindChartGestures(options: GestureOptions) {
  const { host, chart, series, manager, coords } = options;
  const events = host.ownerDocument.defaultView;
  if (!events) throw new Error('Окно графика недоступно.');
  type Copy = NonNullable<ReturnType<typeof prepareDrawingCopy>>;
  interface Gesture {
    pointerId: number;
    origin: Pt;
    pane: { width: number; height: number };
    restore: Pick<
      ReturnType<IChartApi['options']>,
      'handleScroll' | 'handleScale'
    >;
    selection: string[];
    copy?: Copy;
    added: boolean;
    ruler?: RulerMeasurement;
  }
  let gesture: Gesture | undefined;

  const position = (event: PointerEvent): Pt => {
    const bounds = host.getBoundingClientRect();
    const paneTop =
      series.getPane().getHTMLElement()?.getBoundingClientRect().top ??
      bounds.top;
    return {
      x: event.clientX - bounds.left - chart.priceScale('left').width(),
      y: event.clientY - paneTop,
    };
  };
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const finish = (cancelled: boolean) => {
    const current = gesture;
    if (!current) return;
    gesture = undefined;
    if (cancelled && current.copy && current.added) {
      manager.remove(current.copy.id);
      manager.select(current.selection);
    }
    chart.applyOptions(current.restore);
    options.measure(undefined);
    if (host.hasPointerCapture(current.pointerId))
      host.releasePointerCapture(current.pointerId);
  };
  const down = (event: PointerEvent) => {
    if (gesture || event.button !== 0 || !options.ready()) return;
    const origin = position(event);
    const pane = chart.paneSize(series.getPane().paneIndex());
    if (
      origin.x < 0 ||
      origin.y < 0 ||
      origin.x > pane.width ||
      origin.y > pane.height
    )
      return;
    const drawing = findDrawingAt(manager, coords, origin, pane);
    const copy =
      event.ctrlKey && drawing
        ? prepareDrawingCopy(drawing, origin, coords, pane)
        : undefined;
    let ruler: RulerMeasurement | undefined;
    if (!copy && !manager.tool() && options.crosshair()) {
      const price = coords.yToPrice(origin.y);
      if (price === null) return;
      const start = { ...origin, price };
      ruler = { start, end: start, ...pane, minMove: coords.pipSize() };
    }
    if (!copy && !ruler) return;
    stop(event);
    const { handleScroll, handleScale } = chart.options();
    gesture = {
      pointerId: event.pointerId,
      origin,
      pane,
      restore: structuredClone({ handleScroll, handleScale }),
      selection: [...manager.selection()],
      copy,
      added: false,
      ruler,
    };
    if (copy) manager.setTool(null);
    chart.applyOptions({ handleScroll: false, handleScale: false });
    host.setPointerCapture(event.pointerId);
    if (ruler) options.measure(ruler);
  };
  const move = (event: PointerEvent) => {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId) return;
    stop(event);
    const point = position(event);
    if (current.copy) {
      if (
        !current.added &&
        Math.hypot(point.x - current.origin.x, point.y - current.origin.y) < 3
      )
        return;
      const drawing = current.copy.move(point);
      if (!drawing) return;
      if (current.added) manager.update(drawing);
      else {
        manager.add(drawing);
        current.added = true;
        manager.select([current.copy.id]);
      }
    } else if (current.ruler) {
      const x = Math.max(0, Math.min(current.pane.width, point.x));
      const y = Math.max(0, Math.min(current.pane.height, point.y));
      const price = coords.yToPrice(y);
      if (price === null) return;
      current.ruler = { ...current.ruler, end: { x, y, price } };
      options.measure(current.ruler);
      const time = coords.xToTime(x);
      if (time !== null) chart.setCrosshairPosition(price, time, series);
    }
  };
  const up = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    move(event);
    finish(false);
  };
  const cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === gesture?.pointerId) finish(true);
  };
  const cancel = () => finish(true);
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && gesture) {
      stop(event);
      cancel();
    }
  };
  const mouse = (event: MouseEvent) => {
    if (gesture && event.button === 0) stop(event);
  };
  host.addEventListener('pointerdown', down, true);
  host.addEventListener('mousedown', mouse, true);
  host.addEventListener('lostpointercapture', cancelPointer);
  events.addEventListener('pointermove', move, true);
  events.addEventListener('pointerup', up, true);
  events.addEventListener('pointercancel', cancelPointer, true);
  events.addEventListener('blur', cancel);
  events.addEventListener('keydown', key, true);

  return {
    active: () => !!gesture,
    cancel,
    destroy() {
      cancel();
      host.removeEventListener('pointerdown', down, true);
      host.removeEventListener('mousedown', mouse, true);
      host.removeEventListener('lostpointercapture', cancelPointer);
      events.removeEventListener('pointermove', move, true);
      events.removeEventListener('pointerup', up, true);
      events.removeEventListener('pointercancel', cancelPointer, true);
      events.removeEventListener('blur', cancel);
      events.removeEventListener('keydown', key, true);
    },
  };
}
