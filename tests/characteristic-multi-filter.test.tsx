import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CharacteristicMultiFilter } from '../src/components/CharacteristicMultiFilter';
import type { TradeCharacteristic } from '../src/domain/trade-characteristics';

const characteristic: TradeCharacteristic = {
  id: 'setup',
  name: 'Стратегия',
  values: ['Пробой', 'Отбой', '-'],
  createdAt: 1,
};

function render(
  value: readonly (string | null)[] | undefined,
  changes: Partial<TradeCharacteristic> = {},
) {
  return renderToStaticMarkup(
    <CharacteristicMultiFilter
      characteristic={{ ...characteristic, ...changes }}
      value={value}
      knownValues={['Архивное значение', 'Пробой']}
      onChange={() => {}}
      idPrefix="custom-test"
    />,
  );
}

describe('custom characteristic multiselect trigger', () => {
  test('distinguishes all from explicitly selecting no values', () => {
    expect(render(undefined)).toContain('Все значения');
    expect(render([])).toContain('Ничего не выбрано');
    expect(render([])).not.toContain('Все значения');
  });

  test('counts selected values, including missing and archived answers, without conflating literal dash', () => {
    expect(render(['Пробой', 'Отбой'])).toContain('Выбрано 2 из 5');
    expect(render([null, '-'])).toContain('Выбрано 2 из 5');
    expect(render(['Архивное значение'])).toContain('Выбрано 1 из 5');
    expect(
      render([null, 'Пробой', 'Отбой', '-', 'Архивное значение']),
    ).toContain('Все значения');
  });

  test('uses the labelled filter button and escapes user-provided labels', () => {
    const html = render(undefined, { name: '<Setup>' });
    expect(html).toContain('id="custom-test-setup"');
    expect(html).toContain('aria-label="Фильтр: &lt;Setup&gt;"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('<select');
  });
});
