import ApexCharts, { type ApexOptions } from 'apexcharts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeTradingSession,
  type ProfitLossBreakdown,
  type SessionAnalytics,
} from '../domain/session-analytics';
import type {
  BalanceHistoryEntry,
  ClosedTrade,
  TradingSession,
} from '../domain/trading';
import { Button } from './ui/button';

interface Props {
  session: TradingSession;
  trades: readonly ClosedTrade[];
  balanceHistory: readonly BalanceHistoryEntry[];
}

const GREEN = '#6eb544';
const RED = '#ef6948';
const BLUE = '#579ce9';
const PURPLE = '#9b5bff';
const numberFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
});
const moneyFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  dateStyle: 'short',
  timeStyle: 'short',
});
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function money(value: number | null | undefined): string {
  return value == null ? '—' : moneyFormat.format(value);
}

function baseOptions(
  type: 'line' | 'bar' | 'radialBar',
  height: number,
): ApexOptions {
  return {
    chart: {
      type,
      height,
      fontFamily: 'inherit',
      foreColor: '#64748b',
      animations: { enabled: false },
      toolbar: { show: false },
      zoom: { enabled: false },
      parentHeightOffset: 0,
    },
    dataLabels: { enabled: false },
    grid: { borderColor: '#eceef1', padding: { left: 3, right: 10 } },
    legend: { show: false },
    stroke: { width: 2 },
    tooltip: { theme: 'light', y: { formatter: (value) => money(value) } },
    yaxis: {
      opposite: true,
      labels: {
        formatter: (value) => numberFormat.format(value),
        style: { fontSize: '10px' },
      },
    },
    xaxis: {
      type: 'datetime',
      axisBorder: { show: false },
      axisTicks: { show: false },
      labels: { datetimeUTC: true, style: { fontSize: '10px' } },
      tooltip: { enabled: false },
    },
    noData: { text: 'Нет данных для графика' },
  };
}

function AnalyticsChart({
  options,
  label,
  height,
}: {
  options: ApexOptions;
  label: string;
  height: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let active = true;
    let chart: ApexCharts | undefined;
    let rendered = false;
    setError(undefined);
    void Promise.resolve()
      .then(async () => {
        if (!active) return;
        chart = new ApexCharts(element, options);
        await chart.render();
        rendered = true;
        if (!active) chart.destroy();
      })
      .catch((cause: unknown) => {
        chart?.destroy();
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Не удалось построить график.',
          );
      });
    return () => {
      active = false;
      if (rendered) chart?.destroy();
    };
  }, [options]);

  return (
    <div className="analytics-chart" style={{ minHeight: height }}>
      <div ref={container} role="img" aria-label={label} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ProfitRing({ analytics }: { analytics: SessionAnalytics }) {
  const { grossProfit, grossLoss, netProfit } = analytics;
  const options = useMemo<ApexOptions>(() => {
    const scale = Math.max(grossProfit, grossLoss);
    return {
      ...baseOptions('radialBar', 238),
      colors: [GREEN, RED],
      series: scale
        ? [(grossProfit / scale) * 100, (grossLoss / scale) * 100]
        : [0, 0],
      labels: ['Gross Profit', 'Gross Loss'],
      fill: { opacity: 1 },
      stroke: { lineCap: 'butt' },
      plotOptions: {
        radialBar: {
          hollow: { size: '73%' },
          endAngle: 355,
          track: { background: '#f2f4f6', margin: 3 },
          dataLabels: { show: false },
        },
      },
      tooltip: { enabled: false },
    };
  }, [grossProfit, grossLoss]);

  return (
    <div className="analytics-profit-ring">
      <div className="analytics-ring-side">
        <Stat label="Gross Profit" value={money(grossProfit)} color={GREEN} />
        <Stat label="Swaps" value={money(analytics.swaps)} />
        <Stat label="Dividends" value={money(analytics.dividends)} />
      </div>
      <div
        className="analytics-ring-plot"
        title="Кольца нормированы на большую из сумм Gross Profit / Gross Loss."
      >
        <AnalyticsChart
          options={options}
          height={238}
          label="Gross Profit и Gross Loss"
        />
        <div className="analytics-ring-total">
          <strong
            className="analytics-total-value"
            style={{ color: netProfit >= 0 ? '#527f32' : RED }}
          >
            {netProfit > 0 ? '+' : ''}
            {money(netProfit)}
          </strong>
          <span>Total, USD</span>
        </div>
      </div>
      <div className="analytics-ring-side analytics-ring-right">
        <Stat label="Gross Loss" value={money(-grossLoss || 0)} color={RED} />
        <Stat label="Commissions" value={money(analytics.commissions)} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="analytics-stat">
      <strong
        className="analytics-stat-value"
        style={{ color: color ?? '#527386' }}
      >
        {value}
      </strong>
      <span>
        {color && <i style={{ background: color }} />}
        {label}
      </span>
    </div>
  );
}

function Gauge({
  label,
  value,
  maximum,
  maximumText,
  suffix = '',
  text,
  hint,
  color = RED,
}: {
  label: string;
  value?: number;
  maximum: number;
  maximumText?: string;
  suffix?: string;
  text?: string;
  hint?: string;
  color?: string;
}) {
  const percent =
    value === undefined
      ? 0
      : Math.max(0, Math.min(100, (value / maximum) * 100));
  return (
    <div className="analytics-gauge" title={hint}>
      <div className="analytics-gauge-title">{label}</div>
      <div className="analytics-gauge-track">
        <div
          className="analytics-gauge-fill"
          style={{
            width: `${percent}%`,
            borderColor: color,
            background: `${color}22`,
          }}
        />
        <span
          className="analytics-gauge-value"
          style={{ left: `clamp(24px, ${percent}%, calc(100% - 24px))` }}
        >
          {text ??
            (value === undefined
              ? '—'
              : `${numberFormat.format(value)}${suffix}`)}
        </span>
      </div>
      <div className="analytics-gauge-range">
        <span>0{suffix}</span>
        <span>{maximumText ?? `${maximum}${suffix}`}</span>
      </div>
    </div>
  );
}

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${numberFormat.format(seconds / 3600)}h`;
  return `${numberFormat.format(seconds / 86_400)}d`;
}

function Metrics({ analytics: a }: { analytics: SessionAnalytics }) {
  return (
    <div className="analytics-metrics">
      <div className="analytics-metric-column">
        <Gauge
          label="Sharpe Ratio"
          value={a.sharpeRatio}
          maximum={5}
          hint="Средний P/L сделки / выборочное стандартное отклонение. Без годового пересчёта; безрисковая ставка 0."
        />
        <Gauge
          label="Profit Factor"
          value={a.profitFactor}
          maximum={4}
          hint="Gross Profit / |Gross Loss|. При отсутствии убытков не определён."
        />
        <Gauge
          label="Recovery Factor"
          value={a.recoveryFactor}
          maximum={7}
          hint="Чистая прибыль / максимальная просадка баланса в USD."
        />
      </div>
      <div className="analytics-metric-column">
        <Gauge
          label="Max. Drawdown"
          value={a.maxDrawdownPercent}
          maximum={100}
          suffix="%"
          color={GREEN}
          hint={`Максимальная относительная просадка баланса. Максимальная денежная просадка: ${money(a.maxDrawdown)} USD.`}
        />
        <Gauge
          label="Max. Deposit Load"
          maximum={100}
          suffix="%"
          color={GREEN}
          hint="Нет данных о марже: движок не моделирует залог и кредитное плечо."
        />
        <div className="analytics-metric-pair">
          <Gauge
            label="Trades per Week"
            hint="Количество закрытых сделок / длительность симуляции в неделях. Для коротких сессий это экстраполированная частота."
            value={a.tradesPerWeek}
            maximum={15}
            color="#94a3b8"
          />
          <Gauge
            label="Average Hold Time"
            value={a.averageHoldSeconds}
            maximum={86_400}
            maximumText="1d"
            text={duration(a.averageHoldSeconds)}
            color="#94a3b8"
          />
        </div>
      </div>
    </div>
  );
}

function ModeSwitch({
  value,
  onChange,
  labels,
  secondDisabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  labels: [string, string];
  secondDisabled?: boolean;
}) {
  return (
    <fieldset
      className="analytics-mode"
      aria-label={`${labels[0]} / ${labels[1]}`}
    >
      {labels.map((label, index) => (
        <Button
          key={label}
          size="sm"
          variant="outline"
          disabled={index === 1 && secondDisabled}
          aria-pressed={value === Boolean(index)}
          onClick={() => onChange(Boolean(index))}
        >
          {label}
        </Button>
      ))}
    </fieldset>
  );
}

function MonthlyTable({
  analytics,
  growth = false,
}: {
  analytics: SessionAnalytics;
  growth?: boolean;
}) {
  const format = (value: number) =>
    growth
      ? analytics.initialBalance === undefined
        ? '—'
        : `${numberFormat.format((value / analytics.initialBalance) * 100)}%`
      : money(value);
  return (
    <div className="analytics-monthly-scroll">
      <table
        className="analytics-monthly"
        aria-label={
          growth
            ? 'Результат по месяцам, проценты'
            : 'Результат по месяцам, USD'
        }
      >
        <thead>
          <tr>
            <th aria-label="Год" />
            {MONTHS.map((month) => (
              <th key={month}>{month}</th>
            ))}
            <th>Year</th>
          </tr>
        </thead>
        <tbody>
          {analytics.monthly.map((year) => (
            <tr key={year.year}>
              <th>{year.year}</th>
              {year.months.map((value, index) => (
                <td key={MONTHS[index]}>{value ? format(value) : '—'}</td>
              ))}
              <td>{format(year.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={14}>
              Total:{' '}
              <strong className="analytics-monthly-total">
                {format(analytics.netProfit)}
              </strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function AnalyticsNotes({ analytics }: { analytics: SessionAnalytics }) {
  return (
    <p className="analytics-note">
      Все даты UTC. Equity и загрузка депозита недоступны: история плавающего
      P/L и маржи не записывается. Комиссии, свопы и дивиденды не моделируются.
      Sharpe рассчитан по P/L закрытых сделок, без годового пересчёта.
      {analytics.initialBalance === undefined &&
        ' Для прежней сессии начальный баланс неизвестен: показан накопленный P/L, рост и относительная просадка недоступны.'}
    </p>
  );
}

export function SessionSummary({ session, trades, balanceHistory }: Props) {
  const analytics = useMemo(
    () => analyzeTradingSession(session, trades, balanceHistory),
    [session, trades, balanceHistory],
  );
  const [growth, setGrowth] = useState(false);
  const options = useMemo<ApexOptions>(
    () => ({
      ...baseOptions('line', 320),
      colors: [growth ? PURPLE : BLUE],
      series: [
        {
          name: growth
            ? 'Growth, %'
            : analytics.initialBalance === undefined
              ? 'Cumulative P/L, USD'
              : 'Balance, USD',
          data: analytics.balanceSeries.map((point) => ({
            x: point.time * 1000,
            y: growth
              ? (point.growthPercent ?? null)
              : (point.balance ?? point.cumulativeProfit),
          })),
        },
      ],
      stroke: { width: 2, curve: 'smooth' },
      markers: { size: 3, strokeWidth: 1.5, hover: { size: 5 } },
      tooltip: {
        x: { formatter: (value) => `${dateFormat.format(Number(value))} UTC` },
        y: { formatter: (value) => `${money(value)}${growth ? '%' : ' USD'}` },
      },
    }),
    [analytics, growth],
  );
  return (
    <div className="session-analytics">
      <div className="analytics-summary-top">
        <ProfitRing analytics={analytics} />
        <Metrics analytics={analytics} />
      </div>
      <div className="analytics-chart-toolbar">
        <div className="analytics-stat-row">
          <Stat
            label={
              analytics.initialBalance === undefined
                ? 'Cumulative P/L, USD'
                : 'Balance, USD'
            }
            value={money(analytics.endingBalance ?? analytics.netProfit)}
            color={BLUE}
          />
          <Stat label="Equity" value="—" color={PURPLE} />
        </div>
        <ModeSwitch
          value={growth}
          onChange={setGrowth}
          labels={['Balance', 'Growth']}
          secondDisabled={analytics.initialBalance === undefined}
        />
      </div>
      <AnalyticsChart
        options={options}
        height={320}
        label={
          growth
            ? 'Рост баланса в процентах'
            : analytics.initialBalance === undefined
              ? 'Накопленный результат закрытых сделок'
              : 'История баланса счёта'
        }
      />
      <MonthlyTable analytics={analytics} growth={growth} />
      <AnalyticsNotes analytics={analytics} />
    </div>
  );
}

function BreakdownChart({
  data,
  label,
  deals,
}: {
  data: ProfitLossBreakdown[];
  label: string;
  deals: boolean;
}) {
  const options = useMemo<ApexOptions>(
    () => ({
      ...baseOptions('bar', 238),
      colors: [GREEN, RED],
      series: [
        {
          name: deals ? 'Winning deals' : 'Profit, USD',
          data: data.map((item) => (deals ? item.wins : item.profit)),
        },
        {
          name: deals ? 'Losing deals' : 'Loss, USD',
          data: data.map((item) => (deals ? item.losses : item.loss)),
        },
      ],
      stroke: { width: 0 },
      plotOptions: { bar: { columnWidth: '30%' } },
      xaxis: {
        type: 'category',
        categories: data.map((item) => item.label),
        labels: { style: { fontSize: '10px' } },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      tooltip: {
        y: {
          formatter: (value) =>
            deals
              ? value === null
                ? '—'
                : numberFormat.format(value)
              : `${money(value)} USD`,
        },
      },
    }),
    [data, deals],
  );
  return (
    <div className="analytics-breakdown">
      <h3>{label}</h3>
      <AnalyticsChart options={options} height={238} label={label} />
    </div>
  );
}

export function SessionProfitLoss({ session, trades, balanceHistory }: Props) {
  const analytics = useMemo(
    () => analyzeTradingSession(session, trades, balanceHistory),
    [session, trades, balanceHistory],
  );
  const [deals, setDeals] = useState(false);
  const options = useMemo<ApexOptions>(
    () => ({
      ...baseOptions('line', 300),
      chart: { ...baseOptions('line', 300).chart, stacked: false },
      colors: ['#b4d99d', '#efa38d', '#475569'],
      series: [
        {
          name: deals ? 'Winning deals' : 'Profit, USD',
          type: 'column',
          data: analytics.daily.map((day) => ({
            x: day.time * 1000,
            y: deals ? day.wins : day.profit,
          })),
        },
        {
          name: deals ? 'Losing deals' : 'Loss, USD',
          type: 'column',
          data: analytics.daily.map((day) => ({
            x: day.time * 1000,
            y: -(deals ? day.losses : day.loss),
          })),
        },
        {
          name: deals ? 'Net deals' : 'Net P/L, USD',
          type: 'line',
          data: analytics.daily.map((day) => ({
            x: day.time * 1000,
            y: deals ? day.wins - day.losses : day.net,
          })),
        },
      ],
      stroke: { width: [0, 0, 1], curve: 'smooth' },
      plotOptions: { bar: { columnWidth: '55%', rangeBarOverlap: true } },
      fill: { opacity: 1 },
      tooltip: {
        x: { format: 'dd.MM.yyyy' },
        y: {
          formatter: (value) =>
            deals
              ? value === null
                ? '—'
                : numberFormat.format(value)
              : `${money(value)} USD`,
        },
      },
    }),
    [analytics, deals],
  );
  return (
    <div className="session-analytics">
      <div className="analytics-chart-toolbar">
        <div className="analytics-stat-row">
          <Stat
            label={deals ? 'Winning deals' : 'Profit'}
            value={
              deals ? String(analytics.wins) : money(analytics.grossProfit)
            }
            color={GREEN}
          />
          <Stat label="Dividends" value={money(analytics.dividends)} />
          <Stat label="Swaps" value={money(analytics.swaps)} />
          <Stat
            label={deals ? 'Losing deals' : 'Loss'}
            value={
              deals
                ? String(analytics.losses)
                : money(-analytics.grossLoss || 0)
            }
            color={RED}
          />
          <Stat
            label="Commissions"
            value={money(analytics.commissions)}
            color={RED}
          />
        </div>
        <ModeSwitch
          value={deals}
          onChange={setDeals}
          labels={['Money', 'Deals']}
        />
      </div>
      <AnalyticsChart
        options={options}
        height={300}
        label={
          deals
            ? 'Количество прибыльных и убыточных сделок по дням'
            : 'Прибыль и убытки по дням'
        }
      />
      <MonthlyTable analytics={analytics} />
      <div className="analytics-profit-bottom">
        <ProfitRing analytics={analytics} />
        <BreakdownChart
          data={analytics.weekday}
          deals={deals}
          label="Days of Week"
        />
        <BreakdownChart
          data={analytics.sources}
          deals={deals}
          label="Trading Sources"
        />
      </div>
      <AnalyticsNotes analytics={analytics} />
    </div>
  );
}
