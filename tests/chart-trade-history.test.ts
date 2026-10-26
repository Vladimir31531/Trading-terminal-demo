import { describe, expect, test } from 'bun:test';
import type { IChartApi } from 'lightweight-charts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  pairTradeMarkers,
  TradeHistory,
  type TradeHistoryLayout,
} from '../src/chart/trade-history';
import { TradeHistoryOverlay } from '../src/components/TradeHistoryOverlay';
import type { TradeMarker } from '../src/domain/trading';

describe('chart trade history', () => {
  test('connects the entry and exit of each closed trade only', () => {
    const open: TradeMarker = {
      id: 'open-1',
      orderId: 'trade-1',
      phase: 'open',
      time: 100,
      price: 10,
      side: 'buy',
    };
    const close: TradeMarker = {
      id: 'close-1',
      orderId: 'trade-1',
      phase: 'close',
      time: 110,
      price: 12,
      side: 'buy',
    };
    const active: TradeMarker = {
      id: 'open-2',
      orderId: 'trade-2',
      phase: 'open',
      time: 120,
      price: 11,
      side: 'sell',
    };

    expect(pairTradeMarkers([open, active, close])).toEqual([{ open, close }]);
  });

  test('keeps the overlay aligned during horizontal and price-scale gestures without redundant updates', () => {
    let x = 40;
    let y = 90;
    let width = 500;
    let height = 300;
    let requested = 0;
    const times: number[] = [];
    const chart = {
      timeScale: () => ({
        width: () => width,
        timeToCoordinate: (time: number) => {
          times.push(time);
          return x;
        },
      }),
      panes: () => [{ getHeight: () => height }],
    } as unknown as IChartApi;
    const layouts: TradeHistoryLayout[] = [];
    const history = new TradeHistory(
      chart,
      '1m',
      () => y,
      (layout) => {
        layouts.push(layout);
      },
    );
    history.attached({ chart, requestUpdate: () => requested++ });
    history.setMarkers([
      {
        id: 'entry',
        orderId: 'trade',
        phase: 'open',
        time: 125,
        price: 10,
        side: 'buy',
      },
    ]);
    expect(requested).toBe(1);
    history.updateAllViews();
    expect(times).toEqual([120]);
    expect(layouts[0]).toMatchObject({
      width: 500,
      height: 300,
      markers: [{ x: 40, y: 90 }],
    });
    history.updateAllViews();
    expect(layouts).toHaveLength(1);

    x = 55;
    y = 110;
    width = 600;
    height = 350;
    history.updateAllViews();
    expect(layouts[1]).toMatchObject({
      width: 600,
      height: 350,
      markers: [{ x: 55, y: 110 }],
    });
    history.detached();
    y = 120;
    history.updateAllViews();
    expect(layouts).toHaveLength(2);
    expect(requested).toBe(1);
  });

  test('renders the requested direction icons and connects the matching trade coordinates', () => {
    const marker: TradeMarker = {
      id: 'buy-open',
      orderId: 'buy',
      phase: 'open',
      time: 100,
      price: 10,
      side: 'buy',
    };
    const layout: TradeHistoryLayout = {
      width: 500,
      height: 300,
      markers: [
        { ...marker, x: 20, y: 100 },
        { ...marker, id: 'buy-close', phase: 'close', x: 80, y: 60 },
        {
          ...marker,
          id: 'sell-open',
          orderId: 'sell',
          side: 'sell',
          x: 100,
          y: 50,
        },
        {
          ...marker,
          id: 'sell-close',
          orderId: 'sell',
          side: 'sell',
          phase: 'close',
          x: 140,
          y: 80,
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(TradeHistoryOverlay, { layout }),
    );
    expect(html).toContain('x1="20" y1="100" x2="80" y2="60"');
    expect(html).toContain('x1="100" y1="50" x2="140" y2="80"');
    expect(html.match(/stroke-dasharray="4 3"/g)).toHaveLength(2);
    expect(html).toContain('data-direction="up" data-phase="open"');
    expect(html).toContain('data-direction="down" data-phase="close"');
    expect(html).toContain('data-direction="down" data-phase="open"');
    expect(html).toContain('data-direction="up" data-phase="close"');
    expect(html.match(/color="#16803c"/g)).toHaveLength(2);
    expect(html.match(/color="#bd2929"/g)).toHaveLength(2);
    expect(html.match(/viewBox="0 0 24 24"/g)).toHaveLength(4);
  });
});
