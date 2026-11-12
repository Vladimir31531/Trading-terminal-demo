import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CharacteristicFilterSelect } from '../src/components/CharacteristicFilterSelect';
import { TradingSessionHistory } from '../src/components/TradingSessionHistory';
import type { TradeCharacteristic } from '../src/domain/trade-characteristics';
import type { ClosedTrade, TradingSession } from '../src/domain/trading';

const session: TradingSession = {
  id: 'session',
  instrumentId: 'gold',
  datasetId: 'csv',
  ticker: 'XAU/USD',
  startedAt: Date.UTC(2026, 0, 1),
  tradeCount: 2,
  totalProfit: 20,
};
const trade: ClosedTrade = {
  id: 'legacy',
  sessionId: session.id,
  ticket: 1,
  instrumentId: session.instrumentId,
  ticker: session.ticker,
  side: 'buy',
  kind: 'market',
  volume: 0.01,
  entryPrice: 4000,
  exitPrice: 4001,
  openedAt: session.startedAt / 1000,
  closedAt: session.startedAt / 1000 + 60,
  profit: 10,
  closeReason: 'manual',
};
const characteristics: TradeCharacteristic[] = [
  { id: 'setup', name: 'Стратегия', values: ['Пробой'], createdAt: 1 },
  { id: 'quality', name: 'Качество', values: ['A', 'B'], createdAt: 2 },
];

describe('trade characteristic columns', () => {
  test('shows current columns, legacy dashes, and the original saved value after options change', () => {
    const html = renderToStaticMarkup(
      <TradingSessionHistory
        session={session}
        trades={[
          trade,
          {
            ...trade,
            id: 'tagged',
            ticket: 2,
            characteristics: { setup: 'Отскок', quality: 'A' },
          },
        ]}
        balanceHistory={[]}
        characteristics={characteristics}
      />,
    );
    expect(html).toContain('<span>Стратегия</span>');
    expect(html).toContain('<span>Качество</span>');
    expect(html).toContain('<td>-</td><td>-</td>');
    expect(html).toContain('<td>Отскок</td><td>A</td>');
  });

  test('keeps trades visible when a characteristic is removed and escapes custom labels', () => {
    const html = renderToStaticMarkup(
      <TradingSessionHistory
        session={session}
        trades={[
          {
            ...trade,
            characteristics: { setup: 'stored but removed', quality: '<A>' },
          },
        ]}
        balanceHistory={[]}
        characteristics={[{ ...characteristics[1], name: '<Quality>' }]}
      />,
    );
    expect(html).not.toContain('stored but removed');
    expect(html).toContain('<span>&lt;Quality&gt;</span>');
    expect(html).toContain('<td>&lt;A&gt;</td>');
    expect(html).toContain('<td>BUY market</td>');
    expect(html).toContain('<td>Вручную</td>');
  });

  test('extends the empty row across all characteristic columns', () => {
    const html = renderToStaticMarkup(
      <TradingSessionHistory
        session={session}
        trades={[]}
        balanceHistory={[]}
        characteristics={characteristics}
      />,
    );
    expect(html).toContain('colSpan="10"');
    expect(html).toContain('Закрытых сделок пока нет');
  });

  test('provides filters only for dates and text columns while reporting the visible trade count', () => {
    const html = renderToStaticMarkup(
      <TradingSessionHistory
        session={session}
        trades={[trade]}
        balanceHistory={[]}
        characteristics={characteristics}
      />,
    );
    for (const label of [
      'Время открытия',
      'Время закрытия',
      'Тип',
      'Причина закрытия',
      'Стратегия',
      'Качество',
    ])
      expect(html).toContain(`aria-label="Фильтр: ${label}"`);
    for (const label of ['Объём', 'Вход', 'Выход', 'Результат, USD'])
      expect(html).not.toContain(`aria-label="Фильтр: ${label}"`);
    expect(html).toContain('Показано 1 из 1');
    expect(html).toContain('value="buy market"');
    expect(html).toContain('value="manual"');
  });

  test('keeps absent values distinct from literal preset values and exposes historic answers', () => {
    const characteristic: TradeCharacteristic = {
      id: 'setup',
      name: 'Сетап',
      createdAt: 1,
      values: ['-', 'missing', 'Все значения', 'value:test'],
    };
    const render = (value: string | null | undefined) =>
      renderToStaticMarkup(
        <CharacteristicFilterSelect
          characteristic={characteristic}
          value={value}
          onChange={() => {}}
          knownValues={['Отскок', '-', 'Отскок']}
          idPrefix="custom-filter"
        />,
      );
    expect(render(null)).toContain('value="missing" selected=""');
    expect(render('-')).toContain('value="value:-" selected=""');
    expect(render('missing')).toContain('value="value:missing" selected=""');
    expect(render('Все значения')).toContain(
      'value="value:Все значения" selected=""',
    );
    const html = render('value:test');
    expect(html).toContain('value="value:value:test" selected=""');
    expect(html).toContain('Отскок (из истории)');
    expect(html.match(/value="value:Отскок"/g)).toHaveLength(1);
    expect(html).toContain('id="custom-filter-setup"');
  });
});
