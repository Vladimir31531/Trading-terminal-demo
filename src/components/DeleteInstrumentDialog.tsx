import { LoaderCircle, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import type { MarketRepository } from '../application/market-repository';
import type { Instrument } from '../domain/market';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface DeleteInstrumentDialogProps {
  instrument: Instrument;
  repository: MarketRepository;
  onClose(): void;
  onDeleted(id: string): void;
}

export function DeleteInstrumentDialog({
  instrument,
  repository,
  onClose,
  onDeleted,
}: DeleteInstrumentDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancelButton = useRef<HTMLButtonElement>(null);

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await repository.deleteInstrument(instrument.id);
      onDeleted(instrument.id);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось удалить инструмент. Попробуйте ещё раз.',
      );
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        role="alertdialog"
        className="instrument-dialog"
        showCloseButton={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelButton.current?.focus();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="dialog-symbol">
            <Trash2 size={20} strokeWidth={1.5} />
          </div>
          <DialogTitle>Удалить инструмент {instrument.ticker}?</DialogTitle>
          <DialogDescription>
            Инструмент, его история и рисунки будут удалены из приложения.
            Исходный CSV останется на диске.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="dialog-actions">
          <Button
            ref={cancelButton}
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </Button>
          <Button disabled={busy} onClick={() => void remove()}>
            {busy ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : (
              <Trash2 size={15} />
            )}
            {busy ? 'Удаляем…' : 'Удалить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
