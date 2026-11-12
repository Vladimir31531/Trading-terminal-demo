import { LoaderCircle, Pencil, Plus, Trash2, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { TradeCharacteristic } from '../domain/trade-characteristics';
import { tradingHistory } from '../infrastructure/trading-history';
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

export function TradeCharacteristicsPage() {
  const [characteristics, setCharacteristics] = useState<TradeCharacteristic[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<TradeCharacteristic | 'new'>();
  const [deleting, setDeleting] = useState<TradeCharacteristic>();
  const [deletionError, setDeletionError] = useState<string>();
  const [deletingBusy, setDeletingBusy] = useState(false);
  const deletionPending = useRef(false);

  useEffect(
    () =>
      tradingHistory.watchCharacteristics(
        (items) => {
          setCharacteristics(items);
          setError(undefined);
          setLoading(false);
        },
        (cause) => {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Не удалось прочитать характеристики сделок.',
          );
          setLoading(false);
        },
      ),
    [],
  );

  async function removeCharacteristic() {
    if (!deleting || deletionPending.current) return;
    deletionPending.current = true;
    setDeletingBusy(true);
    setDeletionError(undefined);
    try {
      await tradingHistory.deleteCharacteristic(deleting.id);
      setDeleting(undefined);
    } catch (cause) {
      setDeletionError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось удалить характеристику.',
      );
    } finally {
      deletionPending.current = false;
      setDeletingBusy(false);
    }
  }

  return (
    <section className="grid min-w-0 gap-5" aria-label="Характеристики сделок">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid max-w-2xl gap-2">
          <h3 className="text-sm font-medium">Характеристики сделок</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Создайте характеристики и варианты ответа. После закрытия сделки вы
            выберете значения, которые появятся в отдельных колонках истории. У
            ранее сохранённых сделок вместо значения будет «-».
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setEditing('new')}
          disabled={loading || Boolean(error)}
        >
          <Plus className="size-3.5" /> Добавить характеристику
        </Button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : loading ? (
        <div className="sessions-state" role="status">
          <LoaderCircle className="animate-spin" size={18} /> Загружаем
          характеристики…
        </div>
      ) : characteristics.length ? (
        <div className="sessions-table-scroll">
          <table className="sessions-table">
            <thead>
              <tr>
                <th>Характеристика</th>
                <th>Возможные значения</th>
                <th className="w-24">
                  <span className="sr-only">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {characteristics.map((characteristic) => (
                <tr key={characteristic.id}>
                  <td>{characteristic.name}</td>
                  <td>
                    <div className="flex flex-wrap gap-1.5">
                      {characteristic.values.map((value) => (
                        <span
                          key={value}
                          className="rounded border bg-muted px-2 py-0.5 text-[11px]"
                        >
                          {value}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Редактировать характеристику"
                        aria-label={`Редактировать характеристику ${characteristic.name}`}
                        onClick={() => setEditing(characteristic)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Удалить характеристику"
                        aria-label={`Удалить характеристику ${characteristic.name}`}
                        onClick={() => {
                          setDeletionError(undefined);
                          setDeleting(characteristic);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="sessions-state">
          Характеристик пока нет. Добавьте первую характеристику.
        </div>
      )}
      {editing && (
        <TradeCharacteristicDialog
          key={editing === 'new' ? 'new' : editing.id}
          characteristic={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deletionPending.current) setDeleting(undefined);
        }}
      >
        <DialogContent
          className="session-delete-dialog"
          showCloseButton={!deletingBusy}
        >
          <DialogHeader>
            <DialogTitle>Удалить характеристику?</DialogTitle>
            <DialogDescription>
              «{deleting?.name}» исчезнет из формы и колонок истории. Сделки, их
              результаты и сохранённые значения останутся в базе.
            </DialogDescription>
          </DialogHeader>
          {deletionError && (
            <p className="form-error" role="alert">
              {deletionError}
            </p>
          )}
          <DialogFooter className="dialog-actions">
            <Button
              variant="outline"
              disabled={deletingBusy}
              onClick={() => setDeleting(undefined)}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              disabled={deletingBusy}
              onClick={() => void removeCharacteristic()}
            >
              {deletingBusy ? 'Удаляем…' : 'Удалить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TradeCharacteristicDialog({
  characteristic,
  onClose,
}: {
  characteristic?: TradeCharacteristic;
  onClose: () => void;
}) {
  const [name, setName] = useState(characteristic?.name ?? '');
  const [values, setValues] = useState(() =>
    (characteristic?.values ?? ['']).map((value) => ({
      id: crypto.randomUUID(),
      value,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saving = useRef(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await tradingHistory.saveCharacteristic({
        id: characteristic?.id ?? crypto.randomUUID(),
        name,
        values: values.map((item) => item.value),
        createdAt: characteristic?.createdAt ?? Date.now(),
      });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось сохранить характеристику.',
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving.current) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {characteristic
              ? 'Редактировать характеристику'
              : 'Новая характеристика'}
          </DialogTitle>
          <DialogDescription>
            Название станет заголовком колонки. Каждый вариант будет доступен в
            селекте при закрытии сделки.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void save(event)} className="grid gap-5">
          <fieldset disabled={busy} className="grid min-w-0 gap-5">
            <div className="form-field">
              <Label htmlFor="characteristic-name">Название</Label>
              <Input
                id="characteristic-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Например, торговая стратегия"
                required
              />
            </div>
            <div className="grid gap-3">
              <h4 className="text-sm font-medium">Возможные значения</h4>
              <div className="grid gap-2">
                {values.map((item, index) => (
                  <div className="flex items-center gap-2" key={item.id}>
                    <Label
                      className="sr-only"
                      htmlFor={`characteristic-value-${item.id}`}
                    >
                      Значение {index + 1}
                    </Label>
                    <Input
                      id={`characteristic-value-${item.id}`}
                      value={item.value}
                      placeholder={`Значение ${index + 1}`}
                      onChange={(event) =>
                        setValues((current) =>
                          current.map((entry) =>
                            entry.id === item.id
                              ? { ...entry, value: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      required
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={values.length === 1}
                      aria-label={`Удалить значение ${index + 1}`}
                      onClick={() =>
                        setValues((current) =>
                          current.filter((entry) => entry.id !== item.id),
                        )
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() =>
                  setValues((current) => [
                    ...current,
                    { id: crypto.randomUUID(), value: '' },
                  ])
                }
              >
                <Plus className="size-3.5" /> Добавить значение
              </Button>
              {characteristic && (
                <p className="text-xs text-muted-foreground">
                  Изменение вариантов не меняет значения уже сохранённых сделок.
                </p>
              )}
            </div>
          </fieldset>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="dialog-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
