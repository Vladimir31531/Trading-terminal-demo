import { describe, expect, test } from 'bun:test';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import {
  type Coords,
  type Drawing,
  type DrawingKind,
  defaultStyleFor,
} from 'lightweight-charts-drawing';
import { bindChartGestures } from '../src/chart/chart-gestures';
import { priceDistance, type RulerMeasurement } from '../src/chart/ruler';

const pane = { width: 200, height: 180 };
const time = (value: number) => value as UTCTimestamp;

function harness({
  crosshair = false,
  tool = null,
  empty = false,
}: {
  crosshair?: boolean;
  tool?: DrawingKind | null;
  empty?: boolean;
} = {}) {
  const events = new EventTarget();
  const captures = new Set<number>();
  const host = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: events },
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture: (id: number) => {
      captures.add(id);
    },
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => {
      captures.delete(id);
    },
  });
  const source: Drawing = {
    id: 'source',
    kind: 'rectangle',
    text: 'Мой уровень',
    points: [
      { time: time(20), price: 120 },
      { time: time(80), price: 80 },
    ],
    style: {
      ...defaultStyleFor('rectangle'),
      color: '#ef4444',
      backgroundColor: '#22c55e',
      transparency: 37,
      width: 3,
    },
  };
  const data: Drawing[] = empty ? [] : [source];
  let selection: string[] = [];
  let currentTool = tool;
  let adds = 0;
  const manager = {
    drawings: () => data,
    drawingsVisible: () => true,
    selection: () => selection,
    select: (ids: readonly string[]) => {
      selection = [...ids];
    },
    tool: () => currentTool,
    setTool: (kind: DrawingKind | null) => {
      currentTool = kind;
    },
    add: (drawing: Drawing) => {
      data.push(drawing);
      adds++;
      return drawing.id;
    },
    update: (drawing: Drawing) => {
      data[data.findIndex((item) => item.id === drawing.id)] = drawing;
    },
    remove: (id: string) => {
      data.splice(
        data.findIndex((item) => item.id === id),
        1,
      );
    },
  };
  const coords: Coords = {
    priceToY: (price) => 200 - price,
    yToPrice: (y) => 200 - y,
    timeToX: Number,
    xToTime: time,
    isLog: () => false,
    barAt: () => null,
    timeToBarIndex: Number,
    barIndexToTime: time,
    bars: () => [],
    visibleTimeRange: () => null,
    indicatorValuesAt: () => [],
    pipSize: () => 0.001,
    addPriceLine: () => {
      throw new Error('Not used by pointer gestures.');
    },
    removePriceLine: () => {},
    zoomToScreenRect: () => {},
    formatTime: String,
    timeAxis: () => ({ ...pane, fontSize: 11, fontFamily: 'sans-serif' }),
    timeInfo: () => ({ timeZone: 'UTC', intraday: true }),
  };
  const original = {
    handleScroll: { pressedMouseMove: true, mouseWheel: false },
    handleScale: { pinch: true, mouseWheel: false },
  };
  const settings: { handleScroll: unknown; handleScale: unknown } =
    structuredClone(original);
  const chart = {
    paneSize: () => pane,
    priceScale: () => ({ width: () => 7 }),
    options: () => settings,
    applyOptions: (patch: Partial<typeof settings>) => {
      Object.assign(settings, patch);
    },
    setCrosshairPosition: () => {},
  };
  const series = {
    getPane: () => ({ paneIndex: () => 0, getHTMLElement: () => host }),
  };
  const measurements: (RulerMeasurement | undefined)[] = [];
  const gestures = bindChartGestures({
    host: host as unknown as HTMLElement,
    chart: chart as unknown as IChartApi,
    series: series as unknown as ISeriesApi<'Candlestick'>,
    manager: manager as Parameters<typeof bindChartGestures>[0]['manager'],
    coords,
    ready: () => true,
    crosshair: () => crosshair,
    measure: (measurement) => {
      measurements.push(measurement);
    },
  });
  const pointer = (
    type: string,
    x: number,
    y: number,
    extra: Record<string, unknown> = {},
  ) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1,
      button: 0,
      clientX: x + 17,
      clientY: y + 20,
      ctrlKey: false,
      ...extra,
    });
    (type === 'pointerdown' || type === 'lostpointercapture'
      ? host
      : events
    ).dispatchEvent(event);
    return event;
  };
  return {
    gestures,
    pointer,
    events,
    host,
    captures,
    data,
    source,
    manager,
    coords,
    measurements,
    settings,
    original,
    adds: () => adds,
  };
}

describe('chart pointer gestures', () => {
  test('Ctrl drag copies an unselected colored rectangle once and leaves its source unchanged', () => {
    const f = harness();
    const snapshot = structuredClone(f.source);
    expect(
      f.pointer('pointerdown', 50, 100, { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(f.settings).toEqual({ handleScroll: false, handleScale: false });
    f.pointer('pointermove', 60, 90);
    f.pointer('pointermove', 70, 80);
    f.pointer('pointerup', 80, 70);
    expect(f.adds()).toBe(1);
    expect(f.data).toHaveLength(2);
    expect(f.source).toEqual(snapshot);
    expect(f.data[1].style).toEqual(snapshot.style);
    expect(f.data[1].text).toBe(snapshot.text);
    expect(f.data[1].id).not.toBe(snapshot.id);
    expect(f.data[1].points).toEqual([
      { time: time(50), price: 150 },
      { time: time(110), price: 110 },
    ]);
    expect(f.manager.selection()).toEqual([f.data[1].id]);
    expect(f.settings).toEqual(f.original);
    expect(f.captures.size).toBe(0);
    f.gestures.destroy();
  });

  test('Ctrl dragging a resize handle translates both copy corners', () => {
    const f = harness();
    f.pointer('pointerdown', 20, 80, { ctrlKey: true });
    f.pointer('pointerup', 30, 70);
    expect(f.data[1].points).toEqual([
      { time: time(30), price: 130 },
      { time: time(90), price: 90 },
    ]);
    expect(f.source.points).toEqual([
      { time: time(20), price: 120 },
      { time: time(80), price: 80 },
    ]);
    f.gestures.destroy();
  });

  test('a click or sub-threshold movement does not duplicate a drawing', () => {
    const f = harness();
    f.pointer('pointerdown', 50, 100, { ctrlKey: true });
    f.pointer('pointermove', 51, 101);
    f.pointer('pointerup', 52, 101);
    expect(f.adds()).toBe(0);
    expect(f.data).toHaveLength(1);
    expect(f.settings).toEqual(f.original);
    f.gestures.destroy();
  });

  test('ordinary dragging stays available to the chart when crosshair is off', () => {
    const f = harness();
    expect(f.pointer('pointerdown', 50, 100).defaultPrevented).toBe(false);
    expect(f.pointer('pointermove', 60, 90).defaultPrevented).toBe(false);
    expect(f.gestures.active()).toBe(false);
    expect(f.settings).toEqual(f.original);
    f.gestures.destroy();
  });

  test('crosshair drag measures 934 points and release outside restores chart controls', () => {
    const f = harness({ crosshair: true, empty: true });
    f.coords.yToPrice = (y) => 4120.684 + (100 - y) * 0.01;
    f.pointer('pointerdown', 50, 100);
    f.pointer('pointermove', 150, 6.6);
    const ruler = f.measurements.at(-1);
    if (!ruler) throw new Error('Expected a ruler measurement.');
    expect(
      priceDistance(ruler.start.price, ruler.end.price, ruler.minMove).points,
    ).toBe(934);
    expect(f.adds()).toBe(0);
    f.pointer('pointerup', 300, -100, { pointerId: 2 });
    expect(f.gestures.active()).toBe(true);
    f.pointer('pointerup', 300, -100);
    expect(f.measurements.at(-1)).toBeUndefined();
    expect(f.settings).toEqual(f.original);
    expect(f.gestures.active()).toBe(false);
    f.gestures.destroy();
  });

  test('ruler ignores axes and clamps dragged endpoints to the price pane', () => {
    const f = harness({ crosshair: true, empty: true });
    for (const [x, y] of [
      [-1, 50],
      [201, 50],
      [50, -1],
      [50, 181],
    ]) {
      expect(f.pointer('pointerdown', x, y).defaultPrevented).toBe(false);
      expect(f.gestures.active()).toBe(false);
    }
    f.pointer('pointerdown', 50, 100);
    f.pointer('pointermove', 300, -100);
    expect(f.measurements.at(-1)?.end).toEqual({ x: 200, y: 0, price: 200 });
    f.pointer('pointermove', -100, 300);
    expect(f.measurements.at(-1)?.end).toEqual({ x: 0, y: 180, price: 20 });
    f.gestures.destroy();
  });

  test('an armed drawing tool takes precedence over ruler and Ctrl copy takes precedence over both', () => {
    const f = harness({ crosshair: true, tool: 'rectangle' });
    expect(f.pointer('pointerdown', 50, 100).defaultPrevented).toBe(false);
    expect(f.gestures.active()).toBe(false);
    expect(f.manager.tool()).toBe('rectangle');
    f.pointer('pointerdown', 50, 100, { ctrlKey: true });
    f.pointer('pointerup', 60, 90);
    expect(f.adds()).toBe(1);
    expect(f.manager.tool()).toBeNull();
    expect(f.measurements.filter(Boolean)).toHaveLength(0);
    f.gestures.destroy();
  });

  test.each([
    'escape',
    'pointercancel',
    'lostpointercapture',
    'blur',
    'destroy',
  ])(
    '%s cancels copies and rulers, restores controls and releases capture',
    (method) => {
      for (const ruler of [false, true]) {
        const f = harness({ crosshair: ruler, empty: ruler });
        f.pointer('pointerdown', 50, 100, { ctrlKey: !ruler });
        f.pointer('pointermove', 60, 90);
        expect(f.gestures.active()).toBe(true);
        if (method === 'destroy') f.gestures.destroy();
        else if (method === 'escape')
          f.events.dispatchEvent(
            Object.assign(new Event('keydown', { cancelable: true }), {
              key: 'Escape',
            }),
          );
        else if (method === 'blur') f.events.dispatchEvent(new Event('blur'));
        else f.pointer(method, 60, 90);
        expect(f.gestures.active()).toBe(false);
        expect(f.settings).toEqual(f.original);
        expect(f.captures.size).toBe(0);
        expect(f.measurements.at(-1)).toBeUndefined();
        expect(f.data).toEqual(ruler ? [] : [f.source]);
        expect(f.manager.selection()).toEqual([]);
        f.gestures.destroy();
        const count = f.measurements.length;
        f.pointer('pointerdown', 50, 100, { ctrlKey: !ruler });
        f.pointer('pointermove', 60, 90);
        expect(f.gestures.active()).toBe(false);
        expect(f.measurements).toHaveLength(count);
      }
    },
  );
});
