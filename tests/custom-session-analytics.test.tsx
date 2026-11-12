import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomSessionAnalytics } from '../src/components/CustomSessionAnalytics';
import type { ClosedTrade, TradingSession } from '../src/domain/trading';

const session: TradingSession = {
  id: 'custom-session',
  instrumentId: 'gold',
  datasetId: 'csv',
  ticker: 'XAU/USD',
  startedAt: Date.UTC(2026, 0, 1),
  initialBalance: 1000,
  simulationStartTime: Date.UTC(2026, 0, 1) / 1000,
  simulationEndTime: Date.UTC(2026, 0, 2) / 1000,
  tradeCount: 3,
  totalProfit: 10,
};

function trade(profit: number, ticket: number): ClosedTrade {
  return {
    id: `custom-${ticket}`,
    sessionId: session.id,
    ticket,
    instrumentId: session.instrumentId,
    ticker: session.ticker,
    side: 'buy',
    kind: 'market',
    volume: 0.01,
    entryPrice: 100,
    exitPrice: 100 + profit,
    openedAt: (session.simulationStartTime ?? 0) + ticket * 100,
    closedAt: (session.simulationStartTime ?? 0) + ticket * 100 + 60,
    profit,
    closeReason: 'manual',
  };
}

describe('custom session result statistics', () => {
  test('includes breakeven trades in percentage denominators and ignores another session', () => {
    const html = renderToStaticMarkup(
      <CustomSessionAnalytics
        session={session}
        trades={[
          trade(20, 1),
          trade(-10, 2),
          trade(0, 3),
          { ...trade(999, 4), sessionId: 'other-session' },
        ]}
        balanceHistory={[]}
        characteristics={[]}
      />,
    );
    expect(html).toContain('Отобрано 3 из 3 сделок');
    expect(html.match(/33,33\s*%/g)).toHaveLength(3);
    expect(html).toContain('Прибыльные сделки');
    expect(html).toContain('Убыточные сделки');
    expect(html).toContain('Безубыточные сделки');
    expect(html).toContain('Характеристики пока не созданы');
    expect(html).toContain('Gross Profit');
    expect(html).toContain('Результат по месяцам, USD');
  });

  test('renders an empty selection with zero percentages rather than invalid ratios', () => {
    const html = renderToStaticMarkup(
      <CustomSessionAnalytics
        session={session}
        trades={[]}
        balanceHistory={[]}
        characteristics={[]}
      />,
    );
    expect(html).toContain('Отобрано 0 из 0 сделок');
    expect(html.match(/>0%</g)).toHaveLength(3);
    expect(html).toContain('В этой сессии пока нет закрытых сделок.');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });
});
