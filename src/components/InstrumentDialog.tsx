import { Check, FileText, LoaderCircle, Upload, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { MarketRepository } from '../application/market-repository';
import type { ImportProgress, Instrument, SourceFile } from '../domain/market';
import { readableFileSize, SourcePicker } from './SourcePicker';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface InstrumentDialogProps {
  open: boolean;
  instrument?: Instrument;
  repository: MarketRepository;
  onOpenChange: (open: boolean) => void;
  onSaved: (instrumentId: string) => Promise<void>;
}

export function InstrumentDialog({
  open,
  instrument,
  repository,
  onOpenChange,
  onSaved,
}: InstrumentDialogProps) {
  const [ticker, setTicker] = useState('');
  const [pointSize, setPointSize] = useState('0.001');
  const [file, setFile] = useState<SourceFile>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<ImportProgress>();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setTicker(instrument?.ticker ?? '');
      setPointSize(
        String(
          instrument?.pointSize ??
            10 ** -Math.max(0, Math.min(8, instrument?.pricePrecision ?? 3)),
        ),
      );
      setFile(undefined);
      setError(undefined);
      setProgress(undefined);
      setPickerOpen(false);
    }
  }, [open, instrument]);

  useEffect(() => () => controller.current?.abort(), []);

  function changeOpen(nextOpen: boolean) {
    if (busy) return;
    onOpenChange(nextOpen);
  }

  function selectFile(selected: SourceFile) {
    setError(undefined);
    if (selected && !/\.csv$/i.test(selected.name)) {
      setError('Выберите файл в формате .csv.');
      setFile(undefined);
      return;
    }
    setFile(selected);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTicker = ticker.trim();
    if (!normalizedTicker) {
      setError('Укажите тикер инструмента.');
      return;
    }
    const normalizedPointSize = Number(pointSize);
    if (!Number.isFinite(normalizedPointSize) || normalizedPointSize <= 0) {
      setError('Размер одного пункта должен быть числом больше нуля.');
      return;
    }
    if (!instrument && !file) {
      setError('Выберите CSV с историей инструмента.');
      return;
    }
    setBusy(true);
    setError(undefined);
    const operation = new AbortController();
    controller.current = operation;
    try {
      let instrumentId = instrument?.id;
      if (file) {
        const saved = await repository.importInstrument(
          {
            ticker: normalizedTicker,
            sourceId: file.id,
            instrumentId,
            pointSize: normalizedPointSize,
          },
          setProgress,
          operation.signal,
        );
        verifySavedPointSize(saved, normalizedPointSize);
        instrumentId = saved.id;
      } else if (instrumentId) {
        const saved = await repository.updateInstrument(
          instrumentId,
          normalizedTicker,
          normalizedPointSize,
        );
        verifySavedPointSize(saved, normalizedPointSize);
      }
      if (instrumentId) await onSaved(instrumentId);
      onOpenChange(false);
    } catch (cause) {
      if (operation.signal.aborted) {
        setProgress(undefined);
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Не удалось сохранить инструмент. Попробуйте ещё раз.',
        );
      }
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="instrument-dialog"
        showCloseButton={!busy}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="dialog-symbol">
            <Upload size={20} strokeWidth={1.5} />
          </div>
          <DialogTitle>
            {instrument ? 'Редактировать инструмент' : 'Добавить инструмент'}
          </DialogTitle>
          <DialogDescription>
            {instrument
              ? 'Измените тикер или замените историю новым CSV.'
              : 'Подключите CSV с диска, чтобы начать работу с графиком.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => void save(event)}
          className="instrument-form"
        >
          <div className="form-field">
            <Label htmlFor="instrument-ticker">Тикер инструмента</Label>
            <Input
              id="instrument-ticker"
              autoComplete="off"
              placeholder="Например, XAU-USD"
              value={ticker}
              onChange={(event) => setTicker(event.target.value)}
              disabled={busy}
              required
            />
          </div>
          <div className="form-field">
            <Label htmlFor="instrument-point-size">
              Размер одного пункта в цене
            </Label>
            <Input
              id="instrument-point-size"
              type="number"
              min="0"
              step="any"
              value={pointSize}
              onChange={(event) => setPointSize(event.target.value)}
              disabled={busy}
              required
            />
            <p className="format-help">
              Например, 0.001 означает, что движение цены на 0.001 равно одному
              пункту.
            </p>
          </div>
          <div className="form-field">
            <div className="file-label-row">
              <Label htmlFor="instrument-file">Исторические данные</Label>
              {instrument && <span>необязательно</span>}
            </div>
            <button
              type="button"
              id="instrument-file"
              className="file-picker"
              disabled={busy}
              aria-describedby="csv-format"
              onClick={() => setPickerOpen(true)}
            >
              <FileText size={25} strokeWidth={1.3} aria-hidden="true" />
              <span className="file-picker-copy">
                <strong>
                  {file ? file.name : 'Выберите CSV с компьютера'}
                </strong>
                <span>
                  {file
                    ? `${readableFileSize(file.size)} · чтение с диска`
                    : 'Секундные свечи · время UTC'}
                </span>
              </span>
            </button>
            <p id="csv-format" className="format-help">
              Обязательный порядок столбцов:
              <code>Time,Open,High,Low,Close,Volume</code>
            </p>
            {instrument && (
              <p className="replacement-note">
                {file
                  ? 'После успешной загрузки новая история заменит текущую.'
                  : `Текущий файл: ${instrument.fileName}`}
              </p>
            )}
          </div>
          {busy && file && (
            <div className="import-progress" aria-live="polite">
              <div className="progress-caption">
                <span>
                  <LoaderCircle size={14} className="animate-spin" />
                  {progress?.phase === 'saving'
                    ? 'Сохраняем индекс свечей'
                    : file
                      ? 'Обрабатываем CSV'
                      : 'Сохраняем тикер'}
                </span>
                <strong>{Math.floor(progress?.percent ?? 0)}%</strong>
              </div>
              <progress
                max={100}
                value={progress?.percent ?? 0}
                aria-label="Прогресс импорта"
              />
              <span className="progress-detail">
                {new Intl.NumberFormat('ru-RU').format(progress?.rows ?? 0)}{' '}
                строк обработано
              </span>
            </div>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="dialog-actions">
            {busy ? (
              <Button
                type="button"
                variant="outline"
                disabled={!file}
                onClick={() => controller.current?.abort()}
              >
                <X size={15} />
                Отменить
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Отмена
              </Button>
            )}
            <Button
              type="submit"
              disabled={busy || !ticker.trim() || (!instrument && !file)}
            >
              {busy ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : instrument ? (
                <Check size={15} />
              ) : (
                <Upload size={15} />
              )}
              {instrument ? 'Сохранить' : 'Добавить инструмент'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <SourcePicker
        open={pickerOpen}
        repository={repository}
        onOpenChange={setPickerOpen}
        onSelect={selectFile}
      />
    </Dialog>
  );
}

function verifySavedPointSize(
  instrument: Instrument,
  expectedPointSize: number,
): void {
  if (instrument.pointSize !== expectedPointSize)
    throw new Error(
      'Локальный сервис не подтвердил размер пункта. Остановите старый экземпляр через Ctrl+C, перезапустите проект и сохраните инструмент ещё раз.',
    );
}
