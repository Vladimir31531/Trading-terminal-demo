import { describe, expect, test } from 'bun:test';
import type { UTCTimestamp } from 'lightweight-charts';
import {
  type Coords,
  type Drawing,
  defaultStyleFor,
} from 'lightweight-charts-drawing';
import { findDrawingAt, prepareDrawingCopy } from '../src/chart/drawing-copy';

const pane = { width: 200, height: 180 };
const time = (value: number) => value as UTCTimestamp;

function coordinates(overrides: Partial<Coords> = {}): Coords {
  return {
    priceToY: (price) => 200 - price,
    yToPrice: (y) => 200 - y,
    isLog: () => false,
    timeToX: (value) => Number(value),
    xToTime: (x) => time(x),
    barAt: () => null,
    timeToBarIndex: (value) => Number(value),
    barIndexToTime: time,
    bars: () => [],
    visibleTimeRange: () => null,
    indicatorValuesAt: () => [],
    pipSize: () => 0.001,
    addPriceLine: () => {
      throw new Error('Price lines are not used while copying drawings.');
    },
    removePriceLine: () => {},
    zoomToScreenRect: () => {},
    formatTime: String,
    timeAxis: () => ({
      height: 20,
      width: pane.width,
      fontSize: 11,
      fontFamily: 'sans-serif',
    }),
    timeInfo: () => ({ timeZone: 'UTC', intraday: true }),
    ...overrides,
  };
}

function drawing(
  kind: 'horizontal-line' | 'vertical-line' | 'rectangle',
): Drawing {
  const common = {
    id: 'source',
    name: 'Мой рисунок',
    text: 'Подпись',
    locked: false,
    group: 'levels',
    style: {
      ...defaultStyleFor(kind),
      color: '#e11d48',
      backgroundColor: '#f97316',
      width: 3,
      lineStyle: 'dashed' as const,
      transparency: 37,
      textColor: '#111111',
      levels: [{ coeff: 0.5, color: '#abcdef', visible: true }],
    },
  };
  return kind === 'rectangle'
    ? {
        ...common,
        kind,
        points: [
          { time: time(20), price: 120 },
          { time: time(80), price: 80 },
        ],
      }
    : { ...common, kind, points: [{ time: time(20), price: 120 }] };
}

function manager(drawings: Drawing[], selected: string[] = [], visible = true) {
  return {
    drawings: () => drawings,
    selection: () => selected,
    drawingsVisible: () => visible,
  };
}

describe('finding a drawing for Ctrl + drag', () => {
  test('finds an unselected rectangle on its body and its resize handle', () => {
    const source = drawing('rectangle');
    const store = manager([source]);
    expect(findDrawingAt(store, coordinates(), { x: 50, y: 100 }, pane)).toBe(
      source,
    );
    expect(findDrawingAt(store, coordinates(), { x: 20, y: 80 }, pane)).toBe(
      source,
    );
  });

  test('finds the full extent and handle of horizontal and vertical lines', () => {
    const horizontal = drawing('horizontal-line');
    const vertical = drawing('vertical-line');
    for (const cursor of [
      { x: 50, y: 80 },
      { x: pane.width * 0.9, y: 80 },
    ])
      expect(
        findDrawingAt(manager([horizontal]), coordinates(), cursor, pane),
      ).toBe(horizontal);
    for (const cursor of [
      { x: 20, y: 30 },
      { x: 20, y: pane.height * 0.9 },
    ])
      expect(
        findDrawingAt(manager([vertical]), coordinates(), cursor, pane),
      ).toBe(vertical);
  });

  test('uses the topmost drawing and ignores hidden drawings or hidden layers', () => {
    const lower = drawing('rectangle');
    const upper = { ...drawing('rectangle'), id: 'upper' };
    const cursor = { x: 50, y: 100 };
    expect(
      findDrawingAt(manager([lower, upper]), coordinates(), cursor, pane),
    ).toBe(upper);
    expect(
      findDrawingAt(
        manager([lower, { ...upper, hidden: true }]),
        coordinates(),
        cursor,
        pane,
      ),
    ).toBe(lower);
    expect(
      findDrawingAt(manager([lower], [], false), coordinates(), cursor, pane),
    ).toBeUndefined();
    expect(
      findDrawingAt(manager([lower]), coordinates(), { x: -1, y: 80 }, pane),
    ).toBeUndefined();
    expect(
      findDrawingAt(manager([lower]), coordinates(), { x: 50, y: 181 }, pane),
    ).toBeUndefined();
  });

  test('full-pane lines are found when their irrelevant anchor is not mapped', () => {
    const horizontal = drawing('horizontal-line');
    expect(
      findDrawingAt(
        manager([horizontal]),
        coordinates({ timeToX: () => null }),
        { x: 50, y: 80 },
        pane,
      ),
    ).toBe(horizontal);
    const vertical = drawing('vertical-line');
    expect(
      findDrawingAt(
        manager([vertical]),
        coordinates({ priceToY: () => null }),
        { x: 20, y: 30 },
        pane,
      ),
    ).toBe(vertical);
  });
});

describe('independent drawing copies', () => {
  test('preserves every property and deeply separates source and copy', () => {
    const source = drawing('rectangle');
    const snapshot = structuredClone(source);
    const copy = prepareDrawingCopy(
      source,
      { x: 50, y: 100 },
      coordinates(),
      pane,
    );
    const moved = copy?.move({ x: 60, y: 90 });
    expect(moved).not.toBeNull();
    expect(moved?.id).toBe(copy?.id);
    expect(moved?.id).not.toBe(source.id);
    expect(moved?.style).toEqual(source.style);
    expect(moved?.style).not.toBe(source.style);
    expect(moved?.name).toBe(source.name);
    expect(moved?.text).toBe(source.text);
    expect(moved?.locked).toBe(source.locked);
    expect(moved?.group).toBe(source.group);
    expect(source).toEqual(snapshot);
    if (!moved) throw new Error('Expected a copied drawing.');
    moved.style.color = '#000000';
    moved.style.levels?.splice(0, 1);
    moved.points[0].price = -1;
    expect(source).toEqual(snapshot);
  });

  test('a rectangle handle translates the complete copy without resizing', () => {
    const source = drawing('rectangle');
    const copy = prepareDrawingCopy(
      source,
      { x: 20, y: 80 },
      coordinates(),
      pane,
    );
    expect(copy?.move({ x: 30, y: 70 })?.points).toEqual([
      { time: time(30), price: 130 },
      { time: time(90), price: 90 },
    ]);
    // Each move is relative to the press, rather than accumulating drift.
    expect(copy?.move({ x: 40, y: 100 })?.points).toEqual([
      { time: time(40), price: 100 },
      { time: time(100), price: 60 },
    ]);
    expect(source.points).toEqual([
      { time: time(20), price: 120 },
      { time: time(80), price: 80 },
    ]);
  });

  test('horizontal lines move in price while retaining an unmapped anchor time', () => {
    const source = drawing('horizontal-line');
    const copy = prepareDrawingCopy(
      source,
      { x: 50, y: 80 },
      coordinates({ timeToX: () => null, xToTime: () => null }),
      pane,
    );
    expect(copy?.move({ x: 80, y: 60 })?.points).toEqual([
      { time: time(20), price: 140 },
    ]);
    expect(source.points).toEqual([{ time: time(20), price: 120 }]);
  });

  test('vertical lines move in time while retaining an unmapped anchor price', () => {
    const source = drawing('vertical-line');
    const copy = prepareDrawingCopy(
      source,
      { x: 20, y: 50 },
      coordinates({ priceToY: () => null, yToPrice: () => null }),
      pane,
    );
    expect(copy?.move({ x: 60, y: 90 })?.points).toEqual([
      { time: time(60), price: 120 },
    ]);
    expect(source.points).toEqual([{ time: time(20), price: 120 }]);
  });

  test('unmappable geometry does not start a copy or produce an invalid move', () => {
    const source = drawing('rectangle');
    expect(
      prepareDrawingCopy(
        source,
        { x: 50, y: 100 },
        coordinates({ timeToX: () => null }),
        pane,
      ),
    ).toBeUndefined();
    const copy = prepareDrawingCopy(
      source,
      { x: 50, y: 100 },
      coordinates({ xToTime: () => null }),
      pane,
    );
    expect(copy?.move({ x: 60, y: 110 })).toBeNull();
  });
});
