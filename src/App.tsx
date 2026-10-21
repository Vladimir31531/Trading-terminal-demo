import {
  ArrowUpRight,
  ChartCandlestick,
  Database,
  HardDrive,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DeleteInstrumentDialog } from './components/DeleteInstrumentDialog';
import { InstrumentDialog } from './components/InstrumentDialog';
import { MarketChart } from './components/MarketChart';
import { Button } from './components/ui/button';
import { type Instrument, TIMEFRAMES, type Timeframe } from './domain/market';
import { marketRepository } from './infrastructure/market-repository';

const numberFormat = new Intl.NumberFormat('ru-RU');
const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function dateRange(instrument: Instrument) {
  return `${dateFormat.format(instrument.firstTime * 1000)} — ${dateFormat.format(instrument.lastTime * 1000)}`;
}

export default function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingInstrument, setEditingInstrument] = useState<Instrument>();
  const [deletingInstrument, setDeletingInstrument] = useState<Instrument>();
  const selected = instruments.find((item) => item.id === selectedId);

  const refresh = useCallback(async (preferredId?: string) => {
    const items = await marketRepository.listInstruments();
    setInstruments(items);
    setSelectedId(
      (current) =>
        preferredId ??
        (items.some((item) => item.id === current) ? current : items[0]?.id),
    );
  }, []);

  useEffect(() => {
    let active = true;
    marketRepository
      .listInstruments()
      .then((items) => {
        if (active) {
          setInstruments(items);
          setSelectedId(items[0]?.id);
        }
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Не удалось открыть локальную историю.',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function openImport(instrument?: Instrument) {
    setEditingInstrument(instrument);
    setDialogOpen(true);
  }

  function removeInstrument(id: string) {
    setInstruments((current) => current.filter((item) => item.id !== id));
    setSelectedId((current) =>
      current === id ? instruments.find((item) => item.id !== id)?.id : current,
    );
  }

  async function retry() {
    setLoading(true);
    setError(undefined);
    try {
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось открыть локальную историю.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="terminal-app">
      <div className="workspace">
        <aside className="sidebar" aria-label="Инструменты">
          <a
            className="brand sidebar-brand"
            href="/"
            aria-label="Terminal — главная"
          >
            <span className="brand-mark">
              <ChartCandlestick size={18} strokeWidth={1.7} />
            </span>
            <span>
              terminal<span className="brand-period">.</span>
            </span>
          </a>
          <div className="sidebar-heading">
            <span>Инструменты</span>
            <span className="instrument-count">
              {instruments.length.toString().padStart(2, '0')}
            </span>
          </div>
          <Button
            className="sidebar-import"
            variant="outline"
            size="sm"
            onClick={() => openImport()}
            disabled={loading || Boolean(error)}
          >
            <Plus size={15} />
            <span>Добавить инструмент</span>
          </Button>
          <div className="sidebar-list">
            {loading ? (
              <div className="sidebar-message">
                <LoaderCircle size={16} className="animate-spin" />
                <span>Загрузка…</span>
              </div>
            ) : instruments.length === 0 ? (
              <div className="sidebar-empty">
                <Database size={20} strokeWidth={1.3} />
                <p>Здесь появятся ваши инструменты</p>
              </div>
            ) : (
              <ul>
                {instruments.map((instrument) => (
                  <li
                    key={instrument.id}
                    className={`instrument-row ${instrument.id === selectedId ? 'is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className="instrument-select"
                      onClick={() => setSelectedId(instrument.id)}
                      aria-current={
                        instrument.id === selectedId ? 'true' : undefined
                      }
                    >
                      <span className="instrument-icon">
                        <ChartCandlestick size={15} strokeWidth={1.5} />
                      </span>
                      <span className="instrument-copy">
                        <strong>{instrument.ticker}</strong>
                        <span>
                          {numberFormat.format(instrument.rowCount)} строк
                        </span>
                      </span>
                    </button>
                    <Button
                      className="instrument-edit"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Редактировать ${instrument.ticker}`}
                      title="Редактировать инструмент"
                      onClick={() => openImport(instrument)}
                    >
                      <Pencil size={13} />
                    </Button>
                    <Button
                      className="instrument-delete"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Удалить ${instrument.ticker}`}
                      title="Удалить инструмент"
                      onClick={() => setDeletingInstrument(instrument)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="sidebar-footer">
            <HardDrive size={15} strokeWidth={1.5} />
            <div>
              <strong>На этом устройстве</strong>
              <span>История читается с диска</span>
            </div>
          </div>
        </aside>
        <main className="main-panel">
          <div className="chart-header">
            <div className="chart-heading">
              <h1>
                {selected?.ticker ?? 'Графики'}
                {selected && <span className="chart-type-label">OHLC</span>}
              </h1>
            </div>
            {selected ? (
              <fieldset className="timeframe-group" aria-label="Таймфрейм">
                {TIMEFRAMES.map((item) => (
                  <Button
                    key={item}
                    variant="ghost"
                    size="sm"
                    aria-pressed={item === timeframe}
                    className={`timeframe-button ${item === timeframe ? 'is-selected' : ''}`}
                    onClick={() => setTimeframe(item)}
                  >
                    {item}
                  </Button>
                ))}
              </fieldset>
            ) : (
              <span className="history-badge">
                <span />
                Исторические данные
              </span>
            )}
          </div>
          <div className="chart-content">
            {loading ? (
              <div className="center-state">
                <LoaderCircle size={24} className="animate-spin" />
                <p>Открываем рабочее пространство…</p>
              </div>
            ) : error ? (
              <div className="center-state error-state">
                <Database size={28} strokeWidth={1.3} />
                <h2>История недоступна</h2>
                <p role="alert">{error}</p>
                <Button variant="outline" onClick={() => void retry()}>
                  <RefreshCw size={15} />
                  Попробовать снова
                </Button>
              </div>
            ) : selected ? (
              <MarketChart
                key={`${selected.id}:${selected.datasetId}`}
                instrument={selected}
                timeframe={timeframe}
                repository={marketRepository}
              />
            ) : (
              <div className="empty-workspace">
                <div className="empty-chart-art" aria-hidden="true">
                  <div className="art-grid" />
                  <svg viewBox="0 0 280 112" fill="none" aria-hidden="true">
                    <path
                      d="M25 72V103M25 78V93M55 42V91M55 51V78M85 55V90M85 62V81M115 27V72M115 35V58M145 45V78M145 52V68M175 18V62M175 26V49M205 9V48M205 17V35M235 21V58M235 28V48"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <path
                      d="M19 78H31V93H19ZM79 62H91V81H79ZM139 52H151V68H139ZM229 28H241V48H229Z"
                      fill="currentColor"
                    />
                    <path
                      d="M49 51H61V78H49ZM109 35H121V58H109ZM169 26H181V49H169ZM199 17H211V35H199Z"
                      fill="white"
                      stroke="currentColor"
                    />
                  </svg>
                  <span className="art-corner">OHLC / UTC</span>
                </div>
                <div className="empty-copy">
                  <span className="eyebrow">ВАШ РЫНОК. ВАША ИСТОРИЯ.</span>
                  <h2>Всё начинается с графика</h2>
                  <p>Добавьте инструмент и подключите CSV с диска.</p>
                </div>
                <Button className="empty-import" onClick={() => openImport()}>
                  <Plus size={16} />
                  Добавить инструмент
                  <ArrowUpRight size={15} className="empty-arrow" />
                </Button>
              </div>
            )}
          </div>
          <footer className="chart-footer">
            <div className="footer-left">
              <span className="footer-status-dot" />
              <span>{selected ? 'История загружена' : ''}</span>
              {selected && (
                <span className="footer-file" title={selected.fileName}>
                  {selected.fileName}
                </span>
              )}
            </div>
            <div className="footer-right">
              <a
                href="https://www.tradingview.com/"
                target="_blank"
                rel="noreferrer"
                title="TradingView Lightweight Charts™ — Copyright (с) 2025 TradingView, Inc."
              >
                © 2025 TradingView, Inc.
              </a>
              {selected && (
                <span className="footer-date-range">{dateRange(selected)}</span>
              )}
              <span className="utc-badge">UTC+0</span>
            </div>
          </footer>
        </main>
      </div>
      <InstrumentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        instrument={editingInstrument}
        repository={marketRepository}
        onSaved={refresh}
      />
      {deletingInstrument && (
        <DeleteInstrumentDialog
          key={deletingInstrument.id}
          instrument={deletingInstrument}
          repository={marketRepository}
          onClose={() => setDeletingInstrument(undefined)}
          onDeleted={removeInstrument}
        />
      )}
    </div>
  );
}
